// A voice's fingerprint: the sherpa-onnx speaker-embedding extractor over the
// 3D-Speaker CAM++ model (the one upstream Peika's diarizer uses), so that a
// sentence can be told to be the user's voice or another's. Nothing here
// decides anything yet: this is the extractor and its measurement
// (doc/voice-speaker.md).
//
// Like sherpa.rs, the library is loaded at run time through its C API, and
// nothing is written anywhere. A sentence goes in as samples in memory and a
// vector comes out.

use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};

use super::engine;
use super::sherpa::{Library, LIBRARY};

/// The folder of the model, under `engine::dir()`.
const MODEL_DIR: &str = "speaker-campplus";
/// The model's file in that folder.
const MODEL_FILE: &str = "embedding.onnx";
/// 3D-Speaker's CAM++ speaker embedding, as sherpa-onnx's models repository
/// has it, at this pinned revision. Downloading it is a later change.
pub const MODEL_URL: &str = "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx";
/// The size and SHA-256 of that file, to check the download against.
pub const MODEL_BYTES: u64 = 28_281_164;
pub const MODEL_SHA256: &str = "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2";

/// Where the model is, once it is downloaded.
pub fn model_file() -> PathBuf {
    engine::dir().join(MODEL_DIR).join(MODEL_FILE)
}

// ── The extractor ─────────────────────────────────────────────────────────────

/// `SherpaOnnxSpeakerEmbeddingExtractorConfig`, field for field (c-api.h 1.13.8).
#[repr(C)]
struct SpeakerConfig {
    model: *const c_char,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}

type Create = unsafe extern "C" fn(*const SpeakerConfig) -> *const c_void;
type Destroy = unsafe extern "C" fn(*const c_void);
type Dimension = unsafe extern "C" fn(*const c_void) -> i32;
type CreateStream = unsafe extern "C" fn(*const c_void) -> *const c_void;
type Accept = unsafe extern "C" fn(*const c_void, i32, *const f32, i32);
type InputFinished = unsafe extern "C" fn(*const c_void);
type Ready = unsafe extern "C" fn(*const c_void, *const c_void) -> i32;
type Compute = unsafe extern "C" fn(*const c_void, *const c_void) -> *const f32;
type DestroyEmbedding = unsafe extern "C" fn(*const f32);

/// The voices' fingerprints: the extractor, loaded once and used for every
/// sentence. Its vectors come out unit length.
pub struct Voiceprints {
    extractor: *const c_void,
    dim: usize,
    destroy: Destroy,
    create_stream: CreateStream,
    destroy_stream: Destroy,
    accept: Accept,
    input_finished: InputFinished,
    ready: Ready,
    compute: Compute,
    destroy_embedding: DestroyEmbedding,
    // Kept loaded for as long as the functions above may be called.
    _library: Library,
}

// Used from one thread at a time, as the recogniser in sherpa.rs is.
unsafe impl Send for Voiceprints {}

impl Voiceprints {
    /// Loads the library from `runtime` and the model from `model`. Slow (the
    /// model is read): done once.
    pub fn load(runtime: &Path, model: &Path) -> Result<Self, String> {
        let library = Library::open(&runtime.join(LIBRARY))?;
        if !model.is_file() {
            return Err("the voiceprint model is incomplete".into());
        }
        let model = CString::new(model.to_string_lossy().as_bytes()).map_err(|_| "a path has a NUL".to_string())?;
        let provider = CString::new("cpu").unwrap();
        unsafe {
            let config = SpeakerConfig { model: model.as_ptr(), num_threads: 2, debug: 0, provider: provider.as_ptr() };
            let create: Create = library.function("SherpaOnnxCreateSpeakerEmbeddingExtractor")?;
            let dimension: Dimension = library.function("SherpaOnnxSpeakerEmbeddingExtractorDim")?;
            let mut voiceprints = Self {
                extractor: std::ptr::null(),
                dim: 0,
                destroy: library.function("SherpaOnnxDestroySpeakerEmbeddingExtractor")?,
                create_stream: library.function("SherpaOnnxSpeakerEmbeddingExtractorCreateStream")?,
                destroy_stream: library.function("SherpaOnnxDestroyOnlineStream")?,
                accept: library.function("SherpaOnnxOnlineStreamAcceptWaveform")?,
                input_finished: library.function("SherpaOnnxOnlineStreamInputFinished")?,
                ready: library.function("SherpaOnnxSpeakerEmbeddingExtractorIsReady")?,
                compute: library.function("SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding")?,
                destroy_embedding: library.function("SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding")?,
                _library: library,
            };
            voiceprints.extractor = create(&config);
            if voiceprints.extractor.is_null() {
                return Err("the voiceprint model could not be loaded".into());
            }
            // No size, no use: the error drops the extractor, which frees it.
            let dim = dimension(voiceprints.extractor);
            if dim <= 0 {
                return Err("the voiceprint model could not be loaded".into());
            }
            voiceprints.dim = dim as usize;
            Ok(voiceprints)
        }
    }

    /// The length of a fingerprint.
    pub fn dim(&self) -> usize {
        self.dim
    }

    /// The fingerprint of these samples (mono, -1…1, at `sample_rate`), unit
    /// length. None when there is too little voice to tell, or it failed.
    pub fn embed(&self, sample_rate: u32, samples: &[f32]) -> Option<Vec<f32>> {
        if samples.is_empty() {
            return None;
        }
        unsafe {
            let stream = (self.create_stream)(self.extractor);
            if stream.is_null() {
                return None;
            }
            (self.accept)(stream, sample_rate as i32, samples.as_ptr(), samples.len() as i32);
            (self.input_finished)(stream);
            // Too short to make an embedding: none is asked for.
            let embedding = if (self.ready)(self.extractor, stream) != 0 {
                let vector = (self.compute)(self.extractor, stream);
                if vector.is_null() {
                    None
                } else {
                    // Copied out: the library's buffer is its own, and goes back to it.
                    let copied = std::slice::from_raw_parts(vector, self.dim).to_vec();
                    (self.destroy_embedding)(vector);
                    unit_length(copied)
                }
            } else {
                None
            };
            (self.destroy_stream)(stream);
            embedding
        }
    }
}

impl Drop for Voiceprints {
    fn drop(&mut self) {
        if !self.extractor.is_null() {
            unsafe { (self.destroy)(self.extractor) };
        }
    }
}

// ── Measuring ─────────────────────────────────────────────────────────────────

/// Scales a vector to length 1. None for a zero, empty or non-finite one.
fn unit_length(mut vector: Vec<f32>) -> Option<Vec<f32>> {
    // A NaN or an infinity anywhere makes the length non-finite too.
    let length = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !(length.is_finite() && length > 0.0) {
        return None;
    }
    vector.iter_mut().for_each(|x| *x /= length);
    Some(vector)
}

/// How alike two fingerprints are, -1…1. 0 when their lengths differ or one is zero.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a > 0.0 && norm_b > 0.0 {
        dot / (norm_a * norm_b)
    } else {
        0.0
    }
}

/// The voice's profile: the mean of its fingerprints, unit length. None when
/// there are none, their lengths differ, or the mean is zero.
pub fn profile(embeddings: &[Vec<f32>]) -> Option<Vec<f32>> {
    let dim = embeddings.first()?.len();
    if dim == 0 || embeddings.iter().any(|e| e.len() != dim) {
        return None;
    }
    let mut mean = vec![0.0f32; dim];
    for embedding in embeddings {
        for (m, x) in mean.iter_mut().zip(embedding) {
            *m += x;
        }
    }
    let count = embeddings.len() as f32;
    mean.iter_mut().for_each(|m| *m /= count);
    unit_length(mean)
}

/// A WAVE file as mono samples (-1…1) and its rate. Only 16-bit PCM with one
/// or two channels; stereo is the mean of its two channels. Other chunks
/// (LIST, …) are skipped.
pub fn read_wav(bytes: &[u8]) -> Result<(u32, Vec<f32>), String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAVE file".into());
    }
    let mut format = None;
    let mut data = None;
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
        let body = bytes.get(at + 8..at + 8 + size).ok_or("a chunk runs past the end of the file")?;
        if id == b"fmt " {
            format = Some(body);
        } else if id == b"data" {
            data = Some(body);
        }
        // Chunks are padded to an even length.
        at += 8 + size + (size & 1);
    }
    let format = format.ok_or("no fmt chunk")?;
    let data = data.ok_or("no data chunk")?;
    if format.len() < 16 {
        return Err("a short fmt chunk".into());
    }
    let tag = u16::from_le_bytes([format[0], format[1]]);
    let channels = u16::from_le_bytes([format[2], format[3]]);
    let rate = u32::from_le_bytes([format[4], format[5], format[6], format[7]]);
    let bits = u16::from_le_bytes([format[14], format[15]]);
    if tag != 1 {
        return Err(format!("not PCM (format {tag})"));
    }
    if bits != 16 {
        return Err(format!("{bits}-bit samples; only 16-bit is read"));
    }
    if !(1..=2).contains(&channels) {
        return Err(format!("{channels} channels; only mono and stereo are read"));
    }
    if rate == 0 {
        return Err("a sample rate of 0".into());
    }
    let frame = 2 * channels as usize;
    let samples = data
        .chunks_exact(frame)
        .map(|frame| {
            let sum: f32 = frame.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0).sum();
            sum / channels as f32
        })
        .collect();
    Ok((rate, samples))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn cosine_is_one_for_the_same_direction_and_minus_one_for_the_opposite() {
        assert!((cosine(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]) - 1.0).abs() < 1e-6);
        assert!((cosine(&[1.0, 0.0], &[-2.0, 0.0]) + 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 5.0]).abs() < 1e-6);
        assert!((cosine(&[1.0, 1.0], &[1.0, 0.0]) - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    }

    #[test]
    fn cosine_is_zero_for_different_lengths_or_a_zero_vector() {
        assert_eq!(cosine(&[1.0, 0.0], &[1.0, 0.0, 0.0]), 0.0);
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 0.0]), 0.0);
        assert_eq!(cosine(&[], &[]), 0.0);
    }

    #[test]
    fn the_profile_of_two_unit_vectors_is_unit_and_between_them() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        let mean = profile(&[a.clone(), b.clone()]).expect("a profile");
        let length = mean.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((length - 1.0).abs() < 1e-6, "{mean:?}");
        assert!((cosine(&mean, &a) - cosine(&mean, &b)).abs() < 1e-6);
        assert!(cosine(&mean, &a) > 0.0 && cosine(&mean, &a) < 1.0);
        assert!(profile(&[]).is_none());
        // The mean of opposite vectors is nothing: no direction to keep.
        assert!(profile(&[a.clone(), vec![-1.0, 0.0, 0.0]]).is_none());
        assert!(profile(&[a, vec![1.0, 0.0]]).is_none());
    }

    /// One RIFF chunk, padded to an even length as the format asks.
    fn chunk(out: &mut Vec<u8>, id: &[u8; 4], body: &[u8]) {
        out.extend_from_slice(id);
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
        if body.len() % 2 == 1 {
            out.push(0);
        }
    }

    /// A WAVE file as the tests write them: `before` is chunks put before `data`.
    fn wav(channels: u16, rate: u32, bits: u16, before: &[u8], data: &[u8]) -> Vec<u8> {
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&1u16.to_le_bytes());
        fmt.extend_from_slice(&channels.to_le_bytes());
        fmt.extend_from_slice(&rate.to_le_bytes());
        fmt.extend_from_slice(&(rate * u32::from(channels) * u32::from(bits) / 8).to_le_bytes());
        fmt.extend_from_slice(&(channels * bits / 8).to_le_bytes());
        fmt.extend_from_slice(&bits.to_le_bytes());
        let mut body = b"WAVE".to_vec();
        chunk(&mut body, b"fmt ", &fmt);
        body.extend_from_slice(before);
        chunk(&mut body, b"data", data);
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    fn pcm(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn a_mono_wave_file_is_read_past_its_list_chunk() {
        // A LIST chunk of odd size, so its padding is skipped too.
        let mut list = Vec::new();
        chunk(&mut list, b"LIST", b"INFOx");
        let bytes = wav(1, 16_000, 16, &list, &pcm(&[0, 16384, -32768, 32767]));
        let (rate, samples) = read_wav(&bytes).expect("a wave file");
        assert_eq!(rate, 16_000);
        assert_eq!(samples, vec![0.0, 0.5, -1.0, 32767.0 / 32768.0]);
    }

    #[test]
    fn a_stereo_wave_file_is_its_mean() {
        let bytes = wav(2, 44_100, 16, &[], &pcm(&[16384, 0, -16384, -16384, 0, 0]));
        let (rate, samples) = read_wav(&bytes).expect("a wave file");
        assert_eq!(rate, 44_100);
        assert_eq!(samples, vec![0.25, -0.5, 0.0]);
    }

    #[test]
    fn anything_else_is_an_error() {
        assert!(read_wav(b"hello, this is not a wave file at all").is_err());
        assert!(read_wav(&[]).is_err());
        let eight_bit = wav(1, 16_000, 8, &[], &[128, 255, 0]);
        assert!(read_wav(&eight_bit).is_err());
        let three = wav(3, 16_000, 16, &[], &pcm(&[1, 2, 3, 4, 5, 6]));
        assert!(read_wav(&three).is_err());
    }

    /// The measurement, by hand: `PEIKA_VOICE_SAMPLES` is a folder of 16-bit
    /// WAVE files. Each `.wav` in it is a group named by its stem, and each
    /// subfolder is a group of its `.wav` files. The group named `mine` is the
    /// user's: its first five files are the enrolment, its others are "same",
    /// as is every group whose name starts with "mine" ("mine-with-video");
    /// every other group is "other". Prints the scores, the groups, the false
    /// rejections and acceptances for each threshold, and the time of an embedding.
    /// Writes nothing. `cargo test -p peika voice::speaker -- --ignored --nocapture`
    #[test]
    #[ignore = "needs the recordings and the downloaded model"]
    fn voices_on_the_recordings() {
        let Some(folder) = std::env::var_os("PEIKA_VOICE_SAMPLES").map(PathBuf::from) else {
            println!("set PEIKA_VOICE_SAMPLES to a folder of recordings (see the comment above this test)");
            return;
        };
        if !folder.is_dir() {
            println!("missing: {}", folder.display());
            return;
        }
        let model = model_file();
        let runtime = engine::runtime_dir();
        if !model.is_file() {
            println!("missing: {}", model.display());
            return;
        }
        if !runtime.join(LIBRARY).is_file() {
            println!("missing: {}", runtime.join(LIBRARY).display());
            return;
        }
        let voices = match Voiceprints::load(&runtime, &model) {
            Ok(voices) => voices,
            Err(err) => {
                println!("could not load the voiceprints: {err}");
                return;
            }
        };

        let groups = recording_groups(&folder);
        let Some((_, mine)) = groups.iter().find(|(name, _)| name == "mine") else {
            println!("no group named `mine` in {}", folder.display());
            return;
        };
        let mut times = Vec::new();
        let enrolment_count = mine.len().min(5);
        let mut enrolment = Vec::new();
        for path in &mine[..enrolment_count] {
            if let Some(embedding) = embed_file(&voices, path, &mut times) {
                enrolment.push(embedding);
            }
        }
        println!("enrolment: {} of {} files of mine", enrolment.len(), enrolment_count);
        let Some(voiceprint) = profile(&enrolment) else {
            println!("no enrolment could be embedded");
            return;
        };

        // Every file but the enrolment, scored against the profile.
        let mut scored: Vec<(String, bool, String, f32)> = Vec::new();
        for (name, files) in &groups {
            for (at, path) in files.iter().enumerate() {
                if name == "mine" && at < enrolment_count {
                    continue;
                }
                if let Some(embedding) = embed_file(&voices, path, &mut times) {
                    let file = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                    scored.push((name.clone(), name.starts_with("mine"), file, cosine(&embedding, &voiceprint)));
                }
            }
        }
        scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.2.cmp(&b.2)));

        println!("\nscore per file:");
        for (group, same, file, score) in &scored {
            println!("  {:<20} {:<7} {:<44} {:.3}", group, if *same { "same" } else { "other" }, file, score);
        }

        println!("\nper group (count, min, median, max):");
        let mut names: Vec<&String> = scored.iter().map(|s| &s.0).collect();
        names.dedup();
        for name in names {
            let mut scores: Vec<f32> = scored.iter().filter(|s| &s.0 == name).map(|s| s.3).collect();
            scores.sort_by(f32::total_cmp);
            println!(
                "  {:<20} n={:<4} min {:.3}  median {:.3}  max {:.3}",
                name,
                scores.len(),
                scores[0],
                median(&scores).unwrap_or_default(),
                scores[scores.len() - 1]
            );
        }

        let same: Vec<f32> = scored.iter().filter(|s| s.1).map(|s| s.3).collect();
        let other: Vec<f32> = scored.iter().filter(|s| !s.1).map(|s| s.3).collect();
        println!("\nthreshold  false rejection (same under)  false acceptance (other at or above)");
        for step in 0..=12 {
            let threshold = (20 + 5 * step) as f32 / 100.0;
            let rejected = if same.is_empty() {
                "n/a".to_string()
            } else {
                format!("{:.1} %", 100.0 * same.iter().filter(|s| **s < threshold).count() as f32 / same.len() as f32)
            };
            let accepted = if other.is_empty() {
                "n/a".to_string()
            } else {
                format!("{:.1} %", 100.0 * other.iter().filter(|s| **s >= threshold).count() as f32 / other.len() as f32)
            };
            println!("  {threshold:.2}      {rejected:<30} {accepted}");
        }

        times.sort_by(f32::total_cmp);
        println!(
            "\nembed time per file: median {:.0} ms, max {:.0} ms over {} calls",
            median(&times).unwrap_or_default(),
            times.last().copied().unwrap_or_default(),
            times.len()
        );
        println!("dimension: {}", voices.dim());
    }

    /// The `.wav` files directly in `folder` as groups of their own, and each
    /// subfolder as a group of its `.wav` files; sorted by name, files too.
    fn recording_groups(folder: &Path) -> Vec<(String, Vec<PathBuf>)> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(folder).into_iter().flatten().flatten().map(|e| e.path()).collect();
        entries.sort();
        let mut groups = Vec::new();
        for path in entries {
            let name = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            if path.is_file() && is_wav(&path) {
                groups.push((name, vec![path]));
            } else if path.is_dir() {
                let mut files: Vec<PathBuf> = std::fs::read_dir(&path).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file() && is_wav(p)).collect();
                files.sort();
                if !files.is_empty() {
                    groups.push((path.file_name().unwrap_or_default().to_string_lossy().into_owned(), files));
                }
            }
        }
        groups.sort_by(|a, b| a.0.cmp(&b.0));
        groups
    }

    fn is_wav(path: &Path) -> bool {
        path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
    }

    /// One file's fingerprint, and the time it took. Says why when it fails.
    fn embed_file(voices: &Voiceprints, path: &Path, times: &mut Vec<f32>) -> Option<Vec<f32>> {
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let (rate, samples) = match std::fs::read(path).map_err(|err| err.to_string()).and_then(|bytes| read_wav(&bytes)) {
            Ok(read) => read,
            Err(err) => {
                println!("  {name}: could not be read ({err})");
                return None;
            }
        };
        let started = Instant::now();
        let embedding = voices.embed(rate, &samples);
        times.push(started.elapsed().as_secs_f32() * 1000.0);
        if embedding.is_none() {
            println!("  {name}: could not be embedded (too short?)");
        }
        embedding
    }

    /// The middle of sorted values; the mean of the two middle ones when there are two.
    fn median(sorted: &[f32]) -> Option<f32> {
        let n = sorted.len();
        match n {
            0 => None,
            _ if n % 2 == 1 => Some(sorted[n / 2]),
            _ => Some((sorted[n / 2 - 1] + sorted[n / 2]) / 2.0),
        }
    }
}
