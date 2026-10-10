// The microphone, for the bundled speech engine: Windows' default input in
// shared mode, converted by Windows itself to 16 kHz mono floats. Samples are
// handed straight to whoever reads them and kept nowhere here.
//
// It is open only while it exists: dropping it closes the microphone.

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
}

impl Capture {
    pub fn open() -> Result<Self, Unavailable> {
        unsafe {
            let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let opened = Self::start();
            if opened.is_err() && com {
                CoUninitialize();
            }
            opened.map(|(client, capture, event)| Self { client, capture, event, com })
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

#[cfg(test)]
mod tests {
    use super::*;

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
