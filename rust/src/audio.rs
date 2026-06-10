//! Microphone capture for the JS `VoiceRecorder` API. Mirrors the fetch bridge shape
//! (rust/src/hermes.rs `host_fetch`): JS calls a host fn with a small json command, the
//! work happens off the JS thread, and the result is posted back via `hermes::post`.
//!
//! Capture model: `start` opens the default input device at its native config and pushes
//! mono f32 samples into a shared buffer from cpal's audio callback thread. `stop` takes
//! the buffer, downsamples to 16kHz, encodes 16-bit PCM WAV in memory, and replies with
//! base64. `cancel` drops the buffer without replying. Only one recording at a time.
//!
//! While recording, a ~10Hz RMS level event (`__rngpui_audioLevel`) is posted so the UI
//! can show a live meter.
//!
//! Test-only override: if `RNGPUI_FAKE_MIC_WAV` points at a wav file, the mic is never
//! opened — `start` is a no-op and `stop` returns that file's bytes verbatim. This lets
//! the offscreen harness prove the JS→daemon chain when macOS TCC denies real capture in
//! a non-activating context. Production never sets this env, so there is exactly one real
//! capture path.

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use base64::Engine as _;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::hermes::post;

const TARGET_HZ: u32 = 16_000;

struct Recording {
    // the live cpal stream; dropping it stops capture. None in fake-mic mode.
    _stream: Option<cpal::Stream>,
    // mono f32 samples at `source_hz`, filled from the audio callback.
    samples: std::sync::Arc<Mutex<Vec<f32>>>,
    source_hz: u32,
    started: Instant,
    fake_wav: Option<Vec<u8>>,
}

// cpal::Stream isn't Send on every platform; we only ever touch it from the JS thread
// (start/stop/cancel all run on that thread via the host fns), so guarding the whole
// registry behind a Mutex and asserting Send is sound for our single-threaded access.
struct SendRecording(Recording);
unsafe impl Send for SendRecording {}

static CURRENT: OnceLock<Mutex<Option<SendRecording>>> = OnceLock::new();
fn current() -> &'static Mutex<Option<SendRecording>> {
    CURRENT.get_or_init(|| Mutex::new(None))
}

fn fake_mic_wav() -> Option<Vec<u8>> {
    let path = std::env::var_os("RNGPUI_FAKE_MIC_WAV")?;
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) => {
            eprintln!("[audio] RNGPUI_FAKE_MIC_WAV read failed: {e}");
            None
        }
    }
}

/// JS: `__rngpui_audio('{"op":"start","id":N}' | '{"op":"stop","id":N}' | '{"op":"cancel"}')`.
pub fn handle(cmd: &str) {
    let v: serde_json::Value = match serde_json::from_str(cmd) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[audio] bad command json: {e}");
            return;
        }
    };
    let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let id = v.get("id").and_then(|i| i.as_u64()).unwrap_or(0);
    match op {
        "start" => start(id),
        "stop" => stop(id),
        "cancel" => cancel(),
        other => eprintln!("[audio] unknown op {other}"),
    }
}

fn reply_err(id: u64, msg: impl std::fmt::Display) {
    post(
        "__rngpui_audioDone",
        serde_json::json!({ "id": id, "error": msg.to_string() }).to_string(),
    );
}

fn start(id: u64) {
    let mut slot = current().lock().unwrap();
    if slot.is_some() {
        reply_err(id, "already recording");
        return;
    }

    // test-only: skip the mic entirely and stage the canned wav for stop().
    if let Some(bytes) = fake_mic_wav() {
        *slot = Some(SendRecording(Recording {
            _stream: None,
            samples: std::sync::Arc::new(Mutex::new(Vec::new())),
            source_hz: TARGET_HZ,
            started: Instant::now(),
            fake_wav: Some(bytes),
        }));
        post(
            "__rngpui_audioDone",
            serde_json::json!({ "id": id, "ok": true }).to_string(),
        );
        return;
    }

    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            reply_err(id, "no input device");
            return;
        }
    };
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            reply_err(id, format!("input config: {e}"));
            return;
        }
    };
    let source_hz = config.sample_rate().0;
    let channels = config.channels() as usize;
    let samples = std::sync::Arc::new(Mutex::new(Vec::<f32>::new()));
    let level_samples = samples.clone();
    let err_fn = |e| eprintln!("[audio] stream error: {e}");

    // each callback gives interleaved frames; downmix to mono on the way in. cpal hands
    // us the device's native sample format, so build the matching stream variant.
    let buf = samples.clone();
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| push_mono(&buf, data, channels, |s| s),
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                push_mono(&buf, data, channels, |s| s as f32 / 32768.0)
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.into(),
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                push_mono(&buf, data, channels, |s| (s as f32 - 32768.0) / 32768.0)
            },
            err_fn,
            None,
        ),
        other => {
            reply_err(id, format!("unsupported sample format {other:?}"));
            return;
        }
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            reply_err(id, format!("build stream: {e}"));
            return;
        }
    };
    if let Err(e) = stream.play() {
        reply_err(id, format!("play stream: {e}"));
        return;
    }

    // ~10Hz RMS meter while recording. tracks how much of the buffer it has read so each
    // tick measures only fresh samples. self-stops when the recording is taken/cancelled.
    spawn_level_meter(level_samples);

    *slot = Some(SendRecording(Recording {
        _stream: Some(stream),
        samples,
        source_hz,
        started: Instant::now(),
        fake_wav: None,
    }));
    post(
        "__rngpui_audioDone",
        serde_json::json!({ "id": id, "ok": true }).to_string(),
    );
}

fn stop(id: u64) {
    let rec = match current().lock().unwrap().take() {
        Some(r) => r.0,
        None => {
            reply_err(id, "not recording");
            return;
        }
    };
    let duration_ms = rec.started.elapsed().as_millis() as u64;

    // dropping the stream (held inside rec) stops capture before we read the buffer.
    if let Some(bytes) = rec.fake_wav {
        let duration_ms = wav_duration_ms(&bytes).unwrap_or(duration_ms);
        reply_wav(id, &bytes, duration_ms);
        return;
    }

    let mono = std::mem::take(&mut *rec.samples.lock().unwrap());
    let resampled = resample_linear(&mono, rec.source_hz, TARGET_HZ);
    let wav = encode_wav_16k_mono(&resampled);
    reply_wav(id, &wav, duration_ms);
}

fn cancel() {
    *current().lock().unwrap() = None;
}

fn reply_wav(id: u64, wav: &[u8], duration_ms: u64) {
    let base64 = base64::engine::general_purpose::STANDARD.encode(wav);
    post(
        "__rngpui_audioDone",
        serde_json::json!({
            "id": id,
            "ok": true,
            "base64": base64,
            "mimeType": "audio/wav",
            "durationMs": duration_ms,
        })
        .to_string(),
    );
}

fn push_mono<T: Copy>(
    buf: &std::sync::Arc<Mutex<Vec<f32>>>,
    data: &[T],
    channels: usize,
    to_f32: impl Fn(T) -> f32,
) {
    let mut guard = buf.lock().unwrap();
    if channels <= 1 {
        guard.extend(data.iter().map(|&s| to_f32(s)));
        return;
    }
    for frame in data.chunks(channels) {
        let sum: f32 = frame.iter().map(|&s| to_f32(s)).sum();
        guard.push(sum / frame.len() as f32);
    }
}

fn spawn_level_meter(samples: std::sync::Arc<Mutex<Vec<f32>>>) {
    std::thread::spawn(move || {
        let mut read = 0usize;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            // the recording owns the only other Arc ref; once it's taken/cancelled and
            // dropped, our clone is the last one — stop the meter.
            if std::sync::Arc::strong_count(&samples) <= 1 {
                return;
            }
            let guard = samples.lock().unwrap();
            if guard.len() <= read {
                continue;
            }
            let fresh = &guard[read..];
            let sum_sq: f32 = fresh.iter().map(|s| s * s).sum();
            let rms = (sum_sq / fresh.len() as f32).sqrt();
            read = guard.len();
            drop(guard);
            post(
                "__rngpui_audioLevel",
                serde_json::json!({ "level": rms }).to_string(),
            );
        }
    });
}

/// Simple linear-interpolation resampler. Adequate for speech → whisper; the daemon also
/// ffmpeg-normalizes server-side, so we don't need a polyphase filter here.
fn resample_linear(input: &[f32], from_hz: u32, to_hz: u32) -> Vec<f32> {
    if input.is_empty() || from_hz == 0 {
        return Vec::new();
    }
    if from_hz == to_hz {
        return input.to_vec();
    }
    let ratio = to_hz as f64 / from_hz as f64;
    let out_len = (input.len() as f64 * ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let i0 = src.floor() as usize;
        let i1 = (i0 + 1).min(input.len() - 1);
        let frac = (src - i0 as f64) as f32;
        out.push(input[i0] + (input[i1] - input[i0]) * frac);
    }
    out
}

/// Encode mono 16kHz f32 samples as a 16-bit PCM WAV (RIFF) in memory.
fn encode_wav_16k_mono(samples: &[f32]) -> Vec<u8> {
    let num_samples = samples.len() as u32;
    let data_bytes = num_samples * 2;
    let byte_rate = TARGET_HZ * 2; // mono, 2 bytes/sample
    let mut out = Vec::with_capacity(44 + data_bytes as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&TARGET_HZ.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        out.extend_from_slice(&((clamped * 32767.0) as i16).to_le_bytes());
    }
    out
}

/// Read sampleRate + data size from a wav header to report a duration for the fake-mic path.
fn wav_duration_ms(bytes: &[u8]) -> Option<u64> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().ok()?);
    let byte_rate = u32::from_le_bytes(bytes[28..32].try_into().ok()?);
    if byte_rate == 0 || sample_rate == 0 {
        return None;
    }
    // scan chunks for "data" rather than assuming 44-byte header.
    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().ok()?) as usize;
        if id == b"data" {
            return Some((size as u64) * 1000 / byte_rate as u64);
        }
        pos += 8 + size + (size & 1);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_well_formed() {
        // 1600 samples @16k = 100ms of audio.
        let samples = vec![0.0f32; 1600];
        let wav = encode_wav_16k_mono(&samples);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        // 44-byte header + 2 bytes/sample.
        assert_eq!(wav.len(), 44 + 1600 * 2);
        assert_eq!(
            u32::from_le_bytes(wav[24..28].try_into().unwrap()),
            TARGET_HZ
        );
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1); // mono
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16); // bits
        let data_size = u32::from_le_bytes(wav[40..44].try_into().unwrap());
        assert_eq!(data_size, 1600 * 2);
        assert_eq!(wav_duration_ms(&wav), Some(100));
    }

    #[test]
    fn sine_input_roundtrips_to_pcm() {
        // a full-scale sine should survive encode at the extremes (within i16 rounding).
        let n = 16_000;
        let samples: Vec<f32> = (0..n)
            .map(|i| (i as f32 / TARGET_HZ as f32 * 440.0 * std::f32::consts::TAU).sin())
            .collect();
        let wav = encode_wav_16k_mono(&samples);
        assert_eq!(wav.len(), 44 + n * 2);
        // decode the first non-zero sample and check it's a plausible i16.
        let first = i16::from_le_bytes(wav[44..46].try_into().unwrap());
        assert_eq!(first, 0); // sin(0) == 0
        // peak somewhere in the buffer should approach full scale.
        let peak = (44..wav.len())
            .step_by(2)
            .map(|p| i16::from_le_bytes(wav[p..p + 2].try_into().unwrap()).abs())
            .max()
            .unwrap();
        assert!(peak > 30_000, "peak {peak} should approach full scale");
    }

    #[test]
    fn resample_48k_to_16k_thirds_the_length() {
        let input = vec![0.5f32; 4800]; // 100ms @48k
        let out = resample_linear(&input, 48_000, TARGET_HZ);
        // 4800 * (16000/48000) = 1600.
        assert_eq!(out.len(), 1600);
        // constant input stays constant through linear interpolation.
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn resample_same_rate_is_identity() {
        let input = vec![0.1, 0.2, 0.3, 0.4];
        let out = resample_linear(&input, TARGET_HZ, TARGET_HZ);
        assert_eq!(out, input);
    }

    #[test]
    fn resample_empty_is_empty() {
        assert!(resample_linear(&[], 48_000, TARGET_HZ).is_empty());
    }

    #[test]
    fn push_mono_downmixes_stereo() {
        let buf = std::sync::Arc::new(Mutex::new(Vec::<f32>::new()));
        // two stereo frames: (1.0, 0.0) and (0.0, 1.0) → both average to 0.5.
        push_mono(&buf, &[1.0f32, 0.0, 0.0, 1.0], 2, |s| s);
        assert_eq!(*buf.lock().unwrap(), vec![0.5, 0.5]);
    }
}
