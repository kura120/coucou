// The microphone, for the bundled speech engine: Windows' default input in
// shared mode, converted by Windows itself to 16 kHz mono floats. Samples are
// handed straight to whoever reads them and kept nowhere here.
//
// It is open only while it exists: dropping it closes the microphone.
//
// In a debug build only, recordings can stand in for the microphone, so the
// app can be driven by sentences that were recorded once: `COUCOU_VOICE_WAV`
// names a WAV file or a folder of them (16-bit PCM, any rate, taken in the
// order of their names, round and round). Each time a command is listened
// for — after the wake phrase, the "Talk to Coucou" shortcut, or a question
// Mochi asked — the next one is "said"; the rest of the time the room is
// quiet. No release build reads that variable or has this code.

use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use super::vad::SAMPLE_RATE;
use super::Unavailable;

const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
/// AUDCLNT_BUFFERFLAGS_SILENT: the packet is silence, whatever its bytes say.
const SILENT: u32 = 2;
/// Windows' buffer, in 100 ns units: half a second, read several times in that.
const BUFFER: i64 = 5_000_000;

pub struct Capture {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: HANDLE,
    /// CoUninitialize once the interfaces above are released (see Drop).
    com: bool,
    /// Recordings said in place of what the microphone hears.
    #[cfg(debug_assertions)]
    played: Option<played::Played>,
}

impl Capture {
    pub fn open() -> Result<Self, Unavailable> {
        unsafe {
            let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let opened = Self::start();
            if opened.is_err() && com {
                CoUninitialize();
            }
            opened.map(|(client, capture, event)| Self {
                client,
                capture,
                event,
                com,
                #[cfg(debug_assertions)]
                played: played::Played::from_env(),
            })
        }
    }

    /// A command is listened for: the next recording is said, where
    /// recordings stand in for the microphone. Nothing otherwise.
    pub fn say_next(&mut self) {
        #[cfg(debug_assertions)]
        if let Some(played) = self.played.as_mut() {
            played.say_next();
        }
    }

    unsafe fn start() -> Result<(IAudioClient, IAudioCaptureClient, HANDLE), Unavailable> {
        unsafe {
            let devices: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(Unavailable::error)?;
            // No default input, or Windows refuses the microphone to desktop apps.
            let device = devices.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(|_| Unavailable::Microphone)?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|_| Unavailable::Microphone)?;
            let format = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
                nChannels: 1,
                nSamplesPerSec: SAMPLE_RATE,
                nAvgBytesPerSec: SAMPLE_RATE * 4,
                nBlockAlign: 4,
                wBitsPerSample: 32,
                cbSize: 0,
            };
            let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            client
                .Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER, 0, &format, None)
                .map_err(|_| Unavailable::Microphone)?;
            let event = CreateEventW(None, false, false, None).map_err(Unavailable::error)?;
            let ready = (|| {
                client.SetEventHandle(event)?;
                let capture: IAudioCaptureClient = client.GetService()?;
                client.Start()?;
                Ok::<_, windows::core::Error>(capture)
            })();
            match ready {
                Ok(capture) => Ok((client, capture, event)),
                Err(err) => {
                    let _ = CloseHandle(event);
                    Err(Unavailable::error(err))
                }
            }
        }
    }

    /// Waits at most `wait` for sound, then appends everything that has
    /// arrived to `into`. Err: the microphone went away.
    pub fn read(&mut self, wait: Duration, into: &mut Vec<f32>) -> Result<(), Unavailable> {
        #[cfg(debug_assertions)]
        if let Some(played) = self.played.as_mut() {
            // The microphone stays open and unread: what the room says is not heard.
            played.read(wait, into);
            return Ok(());
        }
        unsafe {
            if WaitForSingleObject(self.event, wait.as_millis() as u32) != WAIT_OBJECT_0 {
                return Ok(());
            }
            loop {
                let frames = self.capture.GetNextPacketSize().map_err(|_| Unavailable::Microphone)?;
                if frames == 0 {
                    return Ok(());
                }
                let mut data = std::ptr::null_mut::<u8>();
                let mut count = 0u32;
                let mut flags = 0u32;
                self.capture.GetBuffer(&mut data, &mut count, &mut flags, None, None).map_err(|_| Unavailable::Microphone)?;
                if flags & SILENT != 0 || data.is_null() {
                    into.extend(std::iter::repeat_n(0.0, count as usize));
                } else {
                    // One float per frame: the format asked for above.
                    into.extend_from_slice(std::slice::from_raw_parts(data.cast::<f32>(), count as usize));
                }
                self.capture.ReleaseBuffer(count).map_err(|_| Unavailable::Microphone)?;
            }
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

/// The COM apartment outlives the interfaces: released by the owner after them.
pub fn release_com(capture: Capture) {
    let com = capture.com;
    drop(capture);
    if com {
        unsafe { CoUninitialize() };
    }
}

/// Recordings in place of the microphone: a debug build's way to drive the
/// app with sentences recorded once. Nothing of it exists in a release build.
#[cfg(debug_assertions)]
pub mod played {
    use std::path::Path;
    use std::time::{Duration, Instant};

    use super::SAMPLE_RATE;

    /// The variable that names the WAV file, or the folder of them.
    pub const VARIABLE: &str = "COUCOU_VOICE_WAV";
    /// Quiet before a recording, so its first sound is not the start of the sentence.
    const LEAD: Duration = Duration::from_millis(400);
    /// The most that is handed over in one read: a stalled thread does not get a burst.
    const MOST: Duration = Duration::from_millis(500);

    pub struct Played {
        clips: Vec<Vec<f32>>,
        /// The clip to say next.
        next: usize,
        /// The clip being said, and how far into it (in samples; the lead counts down first).
        saying: Option<(usize, usize)>,
        lead: usize,
        read_at: Instant,
        /// A number that changes, for a room that is quiet but not digital silence.
        hiss: u32,
    }

    /// 16-bit PCM in a RIFF file, any rate, any number of channels, as the
    /// microphone's 16 kHz mono floats. None when it is not that.
    pub fn wav_samples(bytes: &[u8]) -> Option<Vec<f32>> {
        if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return None;
        }
        let (mut at, mut format, mut data) = (12usize, None, None);
        while at + 8 <= bytes.len() {
            let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?) as usize;
            let body = bytes.get(at + 8..(at + 8 + size).min(bytes.len()))?;
            match &bytes[at..at + 4] {
                b"fmt " if body.len() >= 16 => format = Some(body),
                b"data" => data = Some(body),
                _ => {}
            }
            at += 8 + size + (size & 1);
        }
        let (format, data) = (format?, data?);
        let word = |from: usize| u16::from_le_bytes([format[from], format[from + 1]]);
        let (kind, channels, bits) = (word(0), usize::from(word(2)), word(14));
        let rate = u32::from_le_bytes(format[4..8].try_into().ok()?);
        if kind != 1 || bits != 16 || channels == 0 || rate < 8000 {
            return None;
        }
        let mono: Vec<f32> = data
            .chunks_exact(2 * channels)
            .map(|frame| frame.chunks_exact(2).map(|s| f32::from(i16::from_le_bytes([s[0], s[1]])) / 32768.0).sum::<f32>() / channels as f32)
            .collect();
        // To the microphone's rate, a straight line between samples.
        let step = f64::from(rate) / f64::from(SAMPLE_RATE);
        let length = (mono.len() as f64 / step) as usize;
        Some(
            (0..length)
                .map(|i| {
                    let exact = i as f64 * step;
                    let (from, part) = (exact as usize, (exact - exact.floor()) as f32);
                    let (a, b) = (mono[from], *mono.get(from + 1).unwrap_or(&mono[from]));
                    a + (b - a) * part
                })
                .collect(),
        )
    }

    /// The recordings a path names: the file, or the folder's `.wav` files by name.
    pub fn clips(path: &Path) -> Vec<Vec<f32>> {
        let mut files = if path.is_dir() {
            std::fs::read_dir(path)
                .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("wav"))).collect())
                .unwrap_or_default()
        } else {
            vec![path.to_path_buf()]
        };
        files.sort();
        files.iter().filter_map(|file| std::fs::read(file).ok()).filter_map(|bytes| wav_samples(&bytes)).filter(|clip| !clip.is_empty()).collect()
    }

    impl Played {
        /// What `COUCOU_VOICE_WAV` names, when it is set and holds a recording.
        pub fn from_env() -> Option<Self> {
            let path = std::env::var_os(VARIABLE)?;
            let clips = clips(Path::new(&path));
            crate::log::line(format!("voice: {} recordings stand in for the microphone ({VARIABLE})", clips.len()));
            (!clips.is_empty()).then(|| Self::of(clips))
        }

        pub fn of(clips: Vec<Vec<f32>>) -> Self {
            Self { clips, next: 0, saying: None, lead: 0, read_at: Instant::now(), hiss: 1 }
        }

        /// The next recording is said, after a moment of quiet.
        pub fn say_next(&mut self) {
            self.saying = Some((self.next, 0));
            self.next = (self.next + 1) % self.clips.len();
            self.lead = (LEAD.as_secs_f64() * f64::from(SAMPLE_RATE)) as usize;
        }

        /// As the microphone: waits, then hands over what was "heard" since the last read.
        pub fn read(&mut self, wait: Duration, into: &mut Vec<f32>) {
            std::thread::sleep(wait.min(Duration::from_millis(20)));
            let passed = self.read_at.elapsed().min(MOST);
            self.read_at = Instant::now();
            self.give((passed.as_secs_f64() * f64::from(SAMPLE_RATE)) as usize, into);
        }

        /// `count` samples of what is being said, or of a quiet room.
        pub fn give(&mut self, count: usize, into: &mut Vec<f32>) {
            for _ in 0..count {
                let mut sample = None;
                if self.lead > 0 {
                    self.lead -= 1;
                } else if let Some((clip, at)) = self.saying {
                    sample = self.clips[clip].get(at).copied();
                    self.saying = sample.map(|_| (clip, at + 1));
                }
                self.hiss = self.hiss.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                let quiet = ((self.hiss >> 16) & 0xff) as f32 / 255.0 * 0.0008 - 0.0004;
                into.push(sample.unwrap_or(quiet));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
        bytes.extend_from_slice(&(channels * 2).to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&data);
        bytes
    }

    #[test]
    fn a_recording_is_read_as_the_microphone_would_give_it() {
        let loud = vec![16384i16; 1600];
        // Already 16 kHz mono: as it is.
        let same = played::wav_samples(&wav(16_000, 1, &loud)).expect("wav");
        assert_eq!(same.len(), 1600);
        assert!(same.iter().all(|s| (s - 0.5).abs() < 1e-3));
        // 48 kHz stereo: a third as many samples, the two sides averaged.
        let stereo: Vec<i16> = (0..4800).flat_map(|_| [16384i16, 0]).collect();
        let down = played::wav_samples(&wav(48_000, 2, &stereo)).expect("wav");
        assert_eq!(down.len(), 1600);
        assert!(down.iter().all(|s| (s - 0.25).abs() < 1e-3));
        // Not a recording, or not 16-bit PCM: nothing.
        assert!(played::wav_samples(b"not a wav file at all, only some bytes that are long enough").is_none());
        let mut float = wav(16_000, 1, &loud);
        float[20] = 3;
        assert!(played::wav_samples(&float).is_none());
    }

    #[test]
    fn recordings_are_said_one_at_each_command_and_the_room_is_quiet_between() {
        let mut played = played::Played::of(vec![vec![0.5; 800], vec![-0.5; 800]]);
        let mut heard = Vec::new();
        // Nothing is said until a command is listened for.
        played.give(1600, &mut heard);
        assert!(heard.iter().all(|s| s.abs() < 0.001));
        for expected in [0.5f32, -0.5, 0.5] {
            played.say_next();
            heard.clear();
            played.give(16_000, &mut heard);
            let said: Vec<&f32> = heard.iter().filter(|s| s.abs() > 0.1).collect();
            assert_eq!(said.len(), 800);
            assert!(said.iter().all(|s| **s == expected));
            // Quiet first, then the recording, then quiet again.
            assert!(heard[..6000].iter().all(|s| s.abs() < 0.001));
            assert!(heard[8000..].iter().all(|s| s.abs() < 0.001));
        }
    }

    /// The recordings `COUCOU_VOICE_WAV` names, cut out as sentences the way
    /// the listener cuts the microphone: how many there are and how long each
    /// is. `cargo test -p coucou voice::capture -- --ignored --nocapture`
    #[test]
    #[ignore = "reads the recordings COUCOU_VOICE_WAV names"]
    fn the_recordings_named_are_each_cut_out_as_one_sentence() {
        let path = std::env::var_os(played::VARIABLE).expect("COUCOU_VOICE_WAV");
        let clips = played::clips(std::path::Path::new(&path));
        assert!(!clips.is_empty(), "no 16-bit PCM recording there");
        let count = clips.len();
        let mut played = played::Played::of(clips);
        let mut sentences = crate::voice::vad::Sentences::default();
        for at in 0..count {
            played.say_next();
            let mut cut = Vec::new();
            // Ten seconds, 10 ms at a time.
            for _ in 0..1000 {
                let mut heard = Vec::new();
                played.give(160, &mut heard);
                cut.extend(sentences.feed(&heard));
            }
            println!("recording {}: {} sentence(s), {:?} s", at + 1, cut.len(), cut.iter().map(|s| s.len() as f32 / 16_000.0).collect::<Vec<_>>());
            assert_eq!(cut.len(), 1, "recording {}", at + 1);
        }
    }

    /// Opens the real microphone for a second and reads from it:
    /// `cargo test -p coucou voice::capture -- --ignored --nocapture`.
    #[test]
    #[ignore = "opens the microphone"]
    fn the_microphone_gives_sixteen_thousand_samples_a_second() {
        let mut capture = Capture::open().expect("microphone");
        let mut samples = Vec::new();
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_millis(1200) {
            capture.read(Duration::from_millis(100), &mut samples).expect("read");
        }
        let seconds = started.elapsed().as_secs_f64();
        let rate = samples.len() as f64 / seconds;
        let loudest = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
        println!("{} samples in {seconds:.2} s = {rate:.0} per second, loudest {loudest:.4}", samples.len());
        assert!((14_000.0..18_000.0).contains(&rate), "{rate}");
        assert!(samples.iter().all(|s| s.is_finite() && s.abs() <= 1.5));
        release_com(capture);
    }
}
