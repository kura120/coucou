// The bundled speech engine: sherpa-onnx with a Moonshine model, which writes
// down a whole sentence once it has been said. Unlike Windows' grammar
// recogniser it hears anything, not a list — so this is what lets a command
// be said freely.
//
// It is not part of the installer: the user asks for it in Settings and it is
// downloaded then (voice/engine.rs). The library is loaded from that folder at
// run time, through its C API, with nothing linked at build time.
//
// The structs below are `c-api.h` of sherpa-onnx 1.13.8, field for field: the
// version is pinned because this layout is its ABI. A sentence goes in as
// samples in memory and comes out as text; nothing is written anywhere.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;

/// The release whose `c-api.h` the structs here are.
pub const VERSION: &str = "1.13.8";

#[repr(C)]
#[derive(Default)]
struct FeatureConfig {
    sample_rate: i32,
    feature_dim: i32,
}

type Text = *const c_char;

#[repr(C)]
struct Transducer {
    encoder: Text,
    decoder: Text,
    joiner: Text,
}

#[repr(C)]
struct Whisper {
    encoder: Text,
    decoder: Text,
    language: Text,
    task: Text,
    tail_paddings: i32,
    enable_token_timestamps: i32,
    enable_segment_timestamps: i32,
}

#[repr(C)]
struct SenseVoice {
    model: Text,
    language: Text,
    use_itn: i32,
}

#[repr(C)]
struct Moonshine {
    preprocessor: Text,
    encoder: Text,
    uncached_decoder: Text,
    cached_decoder: Text,
    merged_decoder: Text,
}

#[repr(C)]
struct FireRedAsr {
    encoder: Text,
    decoder: Text,
}

#[repr(C)]
struct Canary {
    encoder: Text,
    decoder: Text,
    src_lang: Text,
    tgt_lang: Text,
    use_pnc: i32,
}

#[repr(C)]
struct FunAsrNano {
    encoder_adaptor: Text,
    llm: Text,
    embedding: Text,
    tokenizer: Text,
    system_prompt: Text,
    user_prompt: Text,
    max_new_tokens: i32,
    temperature: f32,
    top_p: f32,
    seed: i32,
    language: Text,
    itn: i32,
    hotwords: Text,
}

#[repr(C)]
struct Qwen3Asr {
    conv_frontend: Text,
    encoder: Text,
    decoder: Text,
    tokenizer: Text,
    max_total_len: i32,
    max_new_tokens: i32,
    temperature: f32,
    top_p: f32,
    seed: i32,
    hotwords: Text,
}

#[repr(C)]
struct CohereTranscribe {
    encoder: Text,
    decoder: Text,
    language: Text,
    use_punct: i32,
    use_itn: i32,
}

#[repr(C)]
struct ModelConfig {
    transducer: Transducer,
    paraformer: Text,
    nemo_ctc: Text,
    whisper: Whisper,
    tdnn: Text,
    tokens: Text,
    num_threads: i32,
    debug: i32,
    provider: Text,
    model_type: Text,
    modeling_unit: Text,
    bpe_vocab: Text,
    telespeech_ctc: Text,
    sense_voice: SenseVoice,
    moonshine: Moonshine,
    fire_red_asr: FireRedAsr,
    dolphin: Text,
    zipformer_ctc: Text,
    canary: Canary,
    wenet_ctc: Text,
    omnilingual: Text,
    medasr: Text,
    funasr_nano: FunAsrNano,
    fire_red_asr_ctc: Text,
    qwen3_asr: Qwen3Asr,
    cohere_transcribe: CohereTranscribe,
}

#[repr(C)]
struct LmConfig {
    model: Text,
    scale: f32,
}

#[repr(C)]
struct HomophoneReplacer {
    dict_dir: Text,
    lexicon: Text,
    rule_fsts: Text,
}

#[repr(C)]
struct RecognizerConfig {
    feat_config: FeatureConfig,
    model_config: ModelConfig,
    lm_config: LmConfig,
    decoding_method: Text,
    max_active_paths: i32,
    hotwords_file: Text,
    hotwords_score: f32,
    rule_fsts: Text,
    rule_fars: Text,
    blank_penalty: f32,
    hr: HomophoneReplacer,
}

/// Only its first field is read.
#[repr(C)]
struct RecognizerResult {
    text: Text,
}

type Create = unsafe extern "C" fn(*const RecognizerConfig) -> *const c_void;
type Destroy = unsafe extern "C" fn(*const c_void);
type CreateStream = unsafe extern "C" fn(*const c_void) -> *const c_void;
type Accept = unsafe extern "C" fn(*const c_void, i32, *const f32, i32);
type Decode = unsafe extern "C" fn(*const c_void, *const c_void);
type GetResult = unsafe extern "C" fn(*const c_void) -> *const RecognizerResult;
type DestroyResult = unsafe extern "C" fn(*const RecognizerResult);

pub struct Engine {
    recognizer: *const c_void,
    destroy: Destroy,
    create_stream: CreateStream,
    destroy_stream: Destroy,
    accept: Accept,
    decode: Decode,
    get_result: GetResult,
    destroy_result: DestroyResult,
    // Kept loaded for as long as the functions above may be called.
    _library: Library,
}

// Used from the one voice thread; the recogniser itself has no thread affinity.
unsafe impl Send for Engine {}

impl Engine {
    /// Loads the library from `runtime` and the model from `model`. Slow (the
    /// model is read): done once, when listening starts.
    pub fn load(runtime: &Path, model: &Path) -> Result<Self, String> {
        let library = Library::open(&runtime.join(LIBRARY))?;
        let text = |path: std::path::PathBuf| CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "a path has a NUL".to_string());
        let encoder = text(model.join("encoder_model.ort"))?;
        let decoder = text(model.join("decoder_model_merged.ort"))?;
        let tokens = text(model.join("tokens.txt"))?;
        let provider = CString::new("cpu").unwrap();
        let greedy = CString::new("greedy_search").unwrap();
        for file in [&encoder, &decoder, &tokens] {
            if !Path::new(file.to_str().unwrap_or_default()).is_file() {
                return Err("the speech model is incomplete".into());
            }
        }
        unsafe {
            // Zeroed, as c-api.h asks; then only what Moonshine needs.
            let mut config: RecognizerConfig = std::mem::zeroed();
            config.feat_config = FeatureConfig { sample_rate: 16000, feature_dim: 80 };
            config.model_config.moonshine.encoder = encoder.as_ptr();
            config.model_config.moonshine.merged_decoder = decoder.as_ptr();
            config.model_config.tokens = tokens.as_ptr();
            config.model_config.num_threads = 2;
            config.model_config.provider = provider.as_ptr();
            config.decoding_method = greedy.as_ptr();

            let create: Create = library.function("SherpaOnnxCreateOfflineRecognizer")?;
            let mut engine = Self {
                recognizer: std::ptr::null(),
                destroy: library.function("SherpaOnnxDestroyOfflineRecognizer")?,
                create_stream: library.function("SherpaOnnxCreateOfflineStream")?,
                destroy_stream: library.function("SherpaOnnxDestroyOfflineStream")?,
                accept: library.function("SherpaOnnxAcceptWaveformOffline")?,
                decode: library.function("SherpaOnnxDecodeOfflineStream")?,
                get_result: library.function("SherpaOnnxGetOfflineStreamResult")?,
                destroy_result: library.function("SherpaOnnxDestroyOfflineRecognizerResult")?,
                _library: library,
            };
            engine.recognizer = create(&config);
            if engine.recognizer.is_null() {
                return Err("the speech model could not be loaded".into());
            }
            Ok(engine)
        }
    }

    /// What was said in these samples (mono, -1…1). Empty when nothing was.
    pub fn transcribe(&self, sample_rate: u32, samples: &[f32]) -> String {
        if samples.is_empty() {
            return String::new();
        }
        unsafe {
            let stream = (self.create_stream)(self.recognizer);
            if stream.is_null() {
                return String::new();
            }
            (self.accept)(stream, sample_rate as i32, samples.as_ptr(), samples.len() as i32);
            (self.decode)(self.recognizer, stream);
            let result = (self.get_result)(stream);
            let text = if result.is_null() || (*result).text.is_null() {
                String::new()
            } else {
                CStr::from_ptr((*result).text).to_string_lossy().trim().to_string()
            };
            if !result.is_null() {
                (self.destroy_result)(result);
            }
            (self.destroy_stream)(stream);
            text
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if !self.recognizer.is_null() {
            unsafe { (self.destroy)(self.recognizer) };
        }
    }
}

// ── Loading the library ───────────────────────────────────────────────────────

#[cfg(windows)]
const LIBRARY: &str = "sherpa-onnx-c-api.dll";
#[cfg(not(windows))]
const LIBRARY: &str = "libsherpa-onnx-c-api.so";

#[cfg(windows)]
struct Library(windows::Win32::Foundation::HMODULE);

#[cfg(windows)]
impl Library {
    /// By its full path, and its own folder searched for what it needs
    /// (onnxruntime.dll) — never the current directory or PATH.
    fn open(path: &Path) -> Result<Self, String> {
        use windows::core::HSTRING;
        use windows::Win32::System::LibraryLoader::{LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};
        if !path.is_absolute() || !path.is_file() {
            return Err("the speech engine is not installed".into());
        }
        unsafe { LoadLibraryExW(&HSTRING::from(path.as_os_str()), None, LOAD_WITH_ALTERED_SEARCH_PATH) }
            .map(Self)
            .map_err(|err| format!("the speech engine could not be loaded: {:#010x}", err.code().0))
    }

    /// `T` must be the function pointer type of that symbol.
    unsafe fn function<T: Copy>(&self, name: &str) -> Result<T, String> {
        use windows::core::PCSTR;
        use windows::Win32::System::LibraryLoader::GetProcAddress;
        let symbol = CString::new(name).map_err(|_| "bad name".to_string())?;
        let address = unsafe { GetProcAddress(self.0, PCSTR(symbol.as_ptr().cast())) }.ok_or_else(|| format!("{name} is missing from the speech engine"))?;
        assert_eq!(std::mem::size_of::<T>(), std::mem::size_of_val(&address));
        Ok(unsafe { std::mem::transmute_copy(&address) })
    }
}

#[cfg(windows)]
impl Drop for Library {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::FreeLibrary(self.0) };
    }
}

/// Linux comes with its own step of the plan.
#[cfg(not(windows))]
struct Library;

#[cfg(not(windows))]
impl Library {
    fn open(_path: &Path) -> Result<Self, String> {
        Err("the speech engine is not available on this system yet".into())
    }

    unsafe fn function<T: Copy>(&self, name: &str) -> Result<T, String> {
        Err(format!("{name} is missing"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The struct sizes c-api.h 1.13.8 gives on a 64-bit target: a field added,
    /// dropped or reordered here would move every pointer after it.
    #[test]
    #[cfg(target_pointer_width = "64")]
    fn the_layout_is_the_headers() {
        assert_eq!(std::mem::size_of::<Whisper>(), 48);
        assert_eq!(std::mem::size_of::<Moonshine>(), 40);
        assert_eq!(std::mem::size_of::<FunAsrNano>(), 88);
        assert_eq!(std::mem::size_of::<Qwen3Asr>(), 64);
        assert_eq!(std::mem::size_of::<ModelConfig>(), 504);
        assert_eq!(std::mem::size_of::<RecognizerConfig>(), 608);
    }

    /// With the real engine and model on disk, a spoken sentence comes back as
    /// its words: `COUCOU_VOICE_RUNTIME`, `COUCOU_VOICE_MODEL` and
    /// `COUCOU_VOICE_WAV` (16-bit mono) say where they are.
    /// `cargo test -p coucou voice::sherpa -- --ignored --nocapture`
    #[test]
    #[ignore = "needs the downloaded engine"]
    fn a_spoken_sentence_is_written_down() {
        let var = |name: &str| std::path::PathBuf::from(std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set")));
        let engine = Engine::load(&var("COUCOU_VOICE_RUNTIME"), &var("COUCOU_VOICE_MODEL")).expect("engine");
        let bytes = std::fs::read(var("COUCOU_VOICE_WAV")).expect("wav");
        let rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let data = bytes.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
        let samples: Vec<f32> = bytes[data..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        let started = std::time::Instant::now();
        let text = engine.transcribe(rate, &samples);
        println!("heard: {text:?} in {:?} ({} samples at {rate} Hz)", started.elapsed(), samples.len());
        let expected = std::env::var("COUCOU_VOICE_EXPECT").unwrap_or_default().to_lowercase();
        assert!(!text.is_empty());
        for word in expected.split_whitespace() {
            assert!(text.to_lowercase().contains(word), "{word:?} not in {text:?}");
        }
        // Twice: a recogniser is reused for every sentence.
        assert_eq!(engine.transcribe(rate, &samples), text);
        assert_eq!(engine.transcribe(rate, &[]), "");
    }
}
