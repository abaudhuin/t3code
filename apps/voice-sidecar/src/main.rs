use std::env;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use parakeet_rs::{ParakeetTDT, TimestampMode, Transcriber};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_MODEL_ID: &str = "parakeet-tdt-0.6b-v3-int8";
const PARAKEET_SAMPLE_RATE: u32 = 16_000;
const PARAKEET_CHANNELS: u16 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
enum VoiceStatus {
    Idle,
    Recording,
    LoadingModel,
    Transcribing,
    Error,
}

impl VoiceStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Recording => "recording",
            Self::LoadingModel => "loading-model",
            Self::Transcribing => "transcribing",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceState {
    status: String,
    model_id: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceModel {
    id: String,
    display_name: String,
    installed: bool,
    is_default: bool,
    download_size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTranscriptEvent {
    text: String,
    #[serde(rename = "final")]
    final_: bool,
    model_id: String,
}

#[derive(Debug, Deserialize)]
struct CommandEnvelope {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelInput {
    model_id: String,
}

#[derive(Debug, Serialize)]
struct ReadyMessage {
    kind: &'static str,
    state: VoiceState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventMessage<T: Serialize> {
    kind: &'static str,
    event: &'static str,
    payload: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseMessage<T: Serialize> {
    kind: &'static str,
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone)]
struct DiscoveredModel {
    id: String,
    dir: PathBuf,
}

struct RecordingSession {
    stream: Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    channels: u16,
}

impl RecordingSession {
    fn finish(self) -> Result<CapturedAudio> {
        drop(self.stream);
        let samples = self
            .samples
            .lock()
            .map_err(|_| anyhow!("Audio capture buffer was poisoned."))?
            .clone();
        Ok(CapturedAudio {
            samples,
            sample_rate: self.sample_rate,
            channels: self.channels,
        })
    }
}

struct PendingModelLoad {
    model_id: String,
    handle: JoinHandle<Result<ParakeetTDT>>,
}

struct CapturedAudio {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
}

struct App {
    writer: BufWriter<io::Stdout>,
    status: VoiceStatus,
    current_model_id: Option<String>,
    message: Option<String>,
    models: Vec<DiscoveredModel>,
    model: Option<ParakeetTDT>,
    pending_model_load: Option<PendingModelLoad>,
    recording: Option<RecordingSession>,
}

impl App {
    fn new() -> Self {
        let models = discover_models();
        let current_model_id = models.first().map(|model| model.id.clone());
        let (status, message) = if current_model_id.is_some() {
            (VoiceStatus::Idle, None)
        } else {
            (
                VoiceStatus::Error,
                Some(
                    "No Parakeet model was found. Set T3CODE_PARAKEET_MODEL_DIR or place the model in the T3 voice models directory."
                        .to_string(),
                ),
            )
        };

        Self {
            writer: BufWriter::new(io::stdout()),
            status,
            current_model_id,
            message,
            models,
            model: None,
            pending_model_load: None,
            recording: None,
        }
    }

    fn current_state(&self) -> VoiceState {
        VoiceState {
            status: self.status.as_str().to_string(),
            model_id: self.current_model_id.clone(),
            message: self.message.clone(),
        }
    }

    fn send_ready(&mut self) -> Result<()> {
        self.write_json(&ReadyMessage {
            kind: "ready",
            state: self.current_state(),
        })
    }

    fn set_state(&mut self, status: VoiceStatus, message: Option<String>) -> Result<()> {
        let previous_status = self.status.clone();
        let previous_message = self.message.clone();
        self.status = status;
        self.message = message;
        if previous_status != self.status || previous_message != self.message {
            self.write_json(&EventMessage {
                kind: "event",
                event: "voice.stateChanged",
                payload: self.current_state(),
            })?;
        }
        Ok(())
    }

    fn send_error_event(&mut self, message: String) -> Result<()> {
        self.set_state(VoiceStatus::Error, Some(message.clone()))?;
        self.write_json(&EventMessage {
            kind: "event",
            event: "voice.error",
            payload: message,
        })
    }

    fn send_response<T: Serialize>(&mut self, id: u64, result: T) -> Result<()> {
        self.write_json(&ResponseMessage {
            kind: "response",
            id,
            ok: true,
            result: Some(result),
            error: None,
        })
    }

    fn send_error_response(&mut self, id: u64, message: String) -> Result<()> {
        self.write_json(&ResponseMessage::<()> {
            kind: "response",
            id,
            ok: false,
            result: None,
            error: Some(message),
        })
    }

    fn write_json<T: Serialize>(&mut self, message: &T) -> Result<()> {
        serde_json::to_writer(&mut self.writer, message)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        Ok(())
    }

    fn list_models(&self) -> Vec<VoiceModel> {
        let current = self.current_model_id.as_deref();
        known_models()
            .into_iter()
            .map(|known| VoiceModel {
                id: known.0.to_string(),
                display_name: known.1.to_string(),
                installed: self.models.iter().any(|model| model.id == known.0),
                is_default: current == Some(known.0),
                download_size_bytes: None,
            })
            .collect()
    }

    fn set_default_model(&mut self, model_id: &str) -> Result<()> {
        let found = self
            .models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| anyhow!("Model \"{}\" is not installed.", model_id))?;
        self.current_model_id = Some(found.id.clone());
        self.model = None;
        self.pending_model_load = None;
        self.set_state(VoiceStatus::Idle, None)
    }

    fn start_recording(&mut self) -> Result<()> {
        if self.status == VoiceStatus::Recording {
            return Ok(());
        }
        if self.status == VoiceStatus::Transcribing {
            return Err(anyhow!("Voice transcription is already in progress."));
        }
        if self.current_model_id.is_none() {
            return Err(anyhow!("No Parakeet model is available."));
        }
        let recording = start_recording_session()?;
        self.recording = Some(recording);
        self.start_model_preload();
        self.set_state(VoiceStatus::Recording, None)
    }

    fn stop_recording(&mut self) -> Result<()> {
        let recording = self
            .recording
            .take()
            .ok_or_else(|| anyhow!("Voice recording is not active."))?;
        let captured = recording.finish()?;
        self.ensure_model_ready()?;
        self.set_state(VoiceStatus::Transcribing, Some("Transcribing…".to_string()))?;

        let transcript = {
            let model = self
                .model
                .as_mut()
                .ok_or_else(|| anyhow!("Parakeet model could not be initialized."))?;
            transcribe_with_model(model, captured)?
        };
        if !transcript.trim().is_empty() {
            let payload = VoiceTranscriptEvent {
                text: transcript,
                final_: true,
                model_id: self
                    .current_model_id
                    .clone()
                    .unwrap_or_else(|| DEFAULT_MODEL_ID.to_string()),
            };
            self.write_json(&EventMessage {
                kind: "event",
                event: "voice.transcriptFinal",
                payload,
            })?;
        }

        self.set_state(VoiceStatus::Idle, None)
    }

    fn cancel_recording(&mut self) -> Result<()> {
        if self.status == VoiceStatus::Transcribing {
            return Err(anyhow!(
                "Voice transcription cannot be cancelled once it has started."
            ));
        }
        if let Some(recording) = self.recording.take() {
            drop(recording);
        }
        self.set_state(VoiceStatus::Idle, None)
    }

    fn start_model_preload(&mut self) {
        if self.model.is_some() || self.pending_model_load.is_some() {
            return;
        }

        let Some(model_id) = self.current_model_id.clone() else {
            return;
        };
        let Some(model_dir) = self.selected_model_dir().map(Path::to_path_buf) else {
            return;
        };

        let handle = thread::spawn(move || load_model_from_dir(&model_dir));
        self.pending_model_load = Some(PendingModelLoad { model_id, handle });
    }

    fn ensure_model_ready(&mut self) -> Result<()> {
        if self.model.is_some() {
            return Ok(());
        }

        if let Some(pending) = self.pending_model_load.take() {
            if self.current_model_id.as_deref() == Some(pending.model_id.as_str()) {
                if !pending.handle.is_finished() {
                    self.set_state(
                        VoiceStatus::LoadingModel,
                        Some("Loading voice model…".to_string()),
                    )?;
                }
                let model = pending
                    .handle
                    .join()
                    .map_err(|_| anyhow!("Voice model preload thread panicked."))??;
                self.model = Some(model);
                return Ok(());
            }
        }

        self.set_state(
            VoiceStatus::LoadingModel,
            Some("Loading voice model…".to_string()),
        )?;
        self.model = Some(self.load_selected_model()?);
        Ok(())
    }

    fn load_selected_model(&self) -> Result<ParakeetTDT> {
        let model_dir = self
            .selected_model_dir()
            .map(Path::to_path_buf)
            .ok_or_else(|| anyhow!("No Parakeet model is available."))?;
        load_model_from_dir(&model_dir)
    }

    fn selected_model_dir(&self) -> Option<&Path> {
        let current = self.current_model_id.as_deref()?;
        self.models
            .iter()
            .find(|model| model.id == current)
            .map(|model| model.dir.as_path())
    }
}

fn known_models() -> [(&'static str, &'static str); 2] {
    [
        ("parakeet-tdt-0.6b-v3-int8", "Parakeet TDT 0.6B v3 Int8"),
        ("parakeet-tdt-0.6b-v3", "Parakeet TDT 0.6B v3"),
    ]
}

fn discover_models() -> Vec<DiscoveredModel> {
    if let Some(explicit_model) = discover_explicit_model() {
        return vec![explicit_model];
    }

    let mut discovered = Vec::new();
    let mut seen_dirs = Vec::<PathBuf>::new();

    for (model_id, _display_name) in known_models() {
        for base_dir in candidate_model_bases() {
            let dir = base_dir.join(model_id);
            if !looks_like_tdt_model_dir(&dir) || seen_dirs.iter().any(|existing| existing == &dir)
            {
                continue;
            }
            seen_dirs.push(dir.clone());
            discovered.push(DiscoveredModel {
                id: model_id.to_string(),
                dir,
            });
        }
    }

    discovered
}

fn discover_explicit_model() -> Option<DiscoveredModel> {
    let explicit_dir = env::var_os("T3CODE_PARAKEET_MODEL_DIR")?;
    let explicit_path = PathBuf::from(explicit_dir);
    if !looks_like_tdt_model_dir(&explicit_path) {
        return None;
    }

    let explicit_model_id = env::var("T3CODE_PARAKEET_MODEL_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL_ID.to_string());

    Some(DiscoveredModel {
        id: explicit_model_id,
        dir: explicit_path,
    })
}

fn candidate_model_bases() -> Vec<PathBuf> {
    let mut bases = Vec::new();

    if let Some(explicit_dir) = env::var_os("T3CODE_PARAKEET_MODEL_DIR") {
        bases.push(PathBuf::from(explicit_dir));
    }

    if let Some(state_dir) = env::var_os("T3CODE_STATE_DIR") {
        bases.push(PathBuf::from(state_dir).join("voice").join("models"));
    }

    if let Some(xdg_data_home) = env::var_os("XDG_DATA_HOME") {
        bases.push(
            PathBuf::from(xdg_data_home)
                .join("t3code")
                .join("voice")
                .join("models"),
        );
    }

    if let Some(home_dir) = env::var_os("HOME") {
        let home = PathBuf::from(home_dir);
        bases.push(
            home.join(".local")
                .join("share")
                .join("t3code")
                .join("voice")
                .join("models"),
        );
    }

    bases
}

fn looks_like_tdt_model_dir(path: &Path) -> bool {
    path.is_dir()
        && path.join("encoder-model.onnx").exists()
        && path.join("decoder_joint-model.onnx").exists()
        && path.join("vocab.txt").exists()
}

fn load_model_from_dir(model_dir: &Path) -> Result<ParakeetTDT> {
    ParakeetTDT::from_pretrained(model_dir, None)
        .with_context(|| format!("Could not load Parakeet model from {}.", model_dir.display()))
}

fn transcribe_with_model(model: &mut ParakeetTDT, captured: CapturedAudio) -> Result<String> {
    let prepared = prepare_audio_for_parakeet(captured)?;
    let result = model
        .transcribe_samples(
            prepared.samples,
            prepared.sample_rate,
            prepared.channels,
            Some(TimestampMode::Sentences),
        )
        .context("Parakeet transcription failed.")?;
    Ok(result.text.trim().to_string())
}

fn prepare_audio_for_parakeet(captured: CapturedAudio) -> Result<CapturedAudio> {
    if captured.samples.is_empty() {
        return Err(anyhow!("No microphone audio was captured."));
    }

    let mono_samples = if captured.channels > 1 {
        downmix_to_mono(&captured.samples, captured.channels)
    } else {
        captured.samples
    };

    if mono_samples.is_empty() {
        return Err(anyhow!("No microphone audio was captured."));
    }

    let resampled_samples = if captured.sample_rate == PARAKEET_SAMPLE_RATE {
        mono_samples
    } else {
        resample_linear(&mono_samples, captured.sample_rate, PARAKEET_SAMPLE_RATE)
    };

    if resampled_samples.is_empty() {
        return Err(anyhow!("Audio resampling produced no samples."));
    }

    Ok(CapturedAudio {
        samples: resampled_samples,
        sample_rate: PARAKEET_SAMPLE_RATE,
        channels: PARAKEET_CHANNELS,
    })
}

fn downmix_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let channel_count = channels as usize;
    samples
        .chunks(channel_count)
        .map(|chunk| chunk.iter().copied().sum::<f32>() / chunk.len() as f32)
        .collect()
}

fn resample_linear(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if samples.is_empty() || source_rate == 0 || target_rate == 0 {
        return Vec::new();
    }

    if source_rate == target_rate || samples.len() == 1 {
        return samples.to_vec();
    }

    let target_len = ((samples.len() as u64 * target_rate as u64) / source_rate as u64) as usize;
    if target_len == 0 {
        return Vec::new();
    }

    let max_index = samples.len() - 1;
    let step = source_rate as f64 / target_rate as f64;
    let mut output = Vec::with_capacity(target_len);

    for i in 0..target_len {
        let source_position = i as f64 * step;
        let left_index = source_position.floor() as usize;
        let right_index = left_index.saturating_add(1).min(max_index);
        let fraction = (source_position - left_index as f64) as f32;
        let left_sample = samples[left_index];
        let right_sample = samples[right_index];
        output.push(left_sample + (right_sample - left_sample) * fraction);
    }

    output
}

fn start_recording_session() -> Result<RecordingSession> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!("No default microphone input device is available."))?;
    let supported_config = device
        .default_input_config()
        .context("Could not read the default microphone configuration.")?;
    let stream_config: StreamConfig = supported_config.clone().into();
    let samples = Arc::new(Mutex::new(Vec::new()));
    let error_fn = |error| {
        eprintln!("voice-capture-error: {error}");
    };

    let stream = match supported_config.sample_format() {
        SampleFormat::I8 => {
            build_input_stream::<i8>(&device, &stream_config, samples.clone(), error_fn)?
        }
        SampleFormat::I16 => {
            build_input_stream::<i16>(&device, &stream_config, samples.clone(), error_fn)?
        }
        SampleFormat::I32 => {
            build_input_stream::<i32>(&device, &stream_config, samples.clone(), error_fn)?
        }
        SampleFormat::I64 => {
            build_input_stream::<i64>(&device, &stream_config, samples.clone(), error_fn)?
        }
        SampleFormat::U8 => {
            build_input_stream::<u8>(&device, &stream_config, samples.clone(), error_fn)?
        }
        SampleFormat::U16 => {
            build_input_stream::<u16>(&device, &stream_config, samples.clone(), error_fn)?
        }
        SampleFormat::U32 => {
            build_input_stream::<u32>(&device, &stream_config, samples.clone(), error_fn)?
        }
        SampleFormat::U64 => {
            build_input_stream::<u64>(&device, &stream_config, samples.clone(), error_fn)?
        }
        SampleFormat::F32 => {
            build_input_stream::<f32>(&device, &stream_config, samples.clone(), error_fn)?
        }
        SampleFormat::F64 => {
            build_input_stream::<f64>(&device, &stream_config, samples.clone(), error_fn)?
        }
        sample_format => {
            return Err(anyhow!(
                "Unsupported microphone sample format: {sample_format:?}"
            ));
        }
    };

    stream
        .play()
        .context("Could not start recording from the microphone.")?;

    Ok(RecordingSession {
        stream,
        samples,
        sample_rate: supported_config.sample_rate(),
        channels: stream_config.channels,
    })
}

fn build_input_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    samples: Arc<Mutex<Vec<f32>>>,
    error_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if let Ok(mut captured) = samples.lock() {
                    captured.extend(data.iter().copied().map(f32::from_sample));
                }
            },
            error_fn,
            None,
        )
        .context("Could not build the microphone input stream.")
}

fn read_model_input(params: Value) -> Result<ModelInput> {
    serde_json::from_value(params).context("Missing or invalid voice model input.")
}

fn main() -> Result<()> {
    let stdin = io::stdin();
    let mut app = App::new();
    app.send_ready()?;

    for line in BufReader::new(stdin.lock()).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                app.send_error_event(format!("Failed to read stdin: {error}"))?;
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let command: CommandEnvelope = match serde_json::from_str(&line) {
            Ok(command) => command,
            Err(error) => {
                app.send_error_event(format!("Invalid command payload: {error}"))?;
                continue;
            }
        };

        let result = match command.method.as_str() {
            "voice.getState" => app.send_response(command.id, app.current_state()),
            "voice.listModels" => app.send_response(command.id, app.list_models()),
            "voice.installModel" => {
                let input = read_model_input(command.params);
                match input {
                    Ok(input) => app.send_error_response(
                        command.id,
                        format!(
                            "Model installation is not implemented yet. Install \"{}\" manually.",
                            input.model_id
                        ),
                    ),
                    Err(error) => app.send_error_response(command.id, error.to_string()),
                }
            }
            "voice.setDefaultModel" => {
                let response = read_model_input(command.params)
                    .and_then(|input| app.set_default_model(&input.model_id));
                match response {
                    Ok(()) => app.send_response(command.id, ()),
                    Err(error) => app.send_error_response(command.id, error.to_string()),
                }
            }
            "voice.startRecording" => match app.start_recording() {
                Ok(()) => app.send_response(command.id, ()),
                Err(error) => app.send_error_response(command.id, error.to_string()),
            },
            "voice.stopRecording" => match app.stop_recording() {
                Ok(()) => app.send_response(command.id, ()),
                Err(error) => app.send_error_response(command.id, error.to_string()),
            },
            "voice.cancelRecording" => match app.cancel_recording() {
                Ok(()) => app.send_response(command.id, ()),
                Err(error) => app.send_error_response(command.id, error.to_string()),
            },
            "voice.shutdown" => {
                app.send_response(command.id, ())?;
                break;
            }
            _ => app.send_error_response(command.id, format!("Unknown method: {}", command.method)),
        };

        if let Err(error) = result {
            let _ = app.send_error_event(error.to_string());
        }
    }

    if let Some(recording) = app.recording.take() {
        drop(recording);
    }

    Ok(())
}
