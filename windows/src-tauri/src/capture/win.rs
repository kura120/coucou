// Screen capture, the Windows half: the screen copied with GDI, PNGs written
// by Windows' own imaging codecs (WIC), the clipboard, and the paste.

use std::ffi::c_void;
use std::path::Path;
use std::time::Duration;

use ::windows::core::HSTRING;
use ::windows::Win32::Foundation::{GENERIC_WRITE, HANDLE, HWND, POINT};
use ::windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
};
use ::windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA, IWICImagingFactory,
    WICBitmapEncoderNoCache,
};
use ::windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use ::windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use ::windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use super::{bottom_up, Frame};

/// The whole desktop, every monitor, in physical pixels: (left, top, width, height).
pub fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

pub fn cursor() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

/// The window in front, unless it is Peika's: where Paste goes back to.
pub fn front_window() -> Option<isize> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32)) };
    (pid != std::process::id()).then_some(hwnd.0 as isize)
}

/// What the screen shows now, top-down BGRA, opaque.
pub fn grab(left: i32, top: i32, width: i32, height: i32) -> Option<Frame> {
    if width <= 0 || height <= 0 {
        return None;
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let memory = CreateCompatibleDC(Some(screen));
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative: rows top-down, as the page and the PNG want them.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let frame = match CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) if !bits.is_null() => {
                let previous = SelectObject(memory, bitmap.into());
                // CAPTUREBLT: layered windows (menus, tooltips) come too.
                let copied = BitBlt(memory, 0, 0, width, height, Some(screen), left, top, SRCCOPY | CAPTUREBLT).is_ok();
                let len = width as usize * height as usize * 4;
                let mut pixels = std::slice::from_raw_parts(bits as *const u8, len).to_vec();
                for alpha in pixels.iter_mut().skip(3).step_by(4) {
                    *alpha = 255;
                }
                SelectObject(memory, previous);
                let _ = DeleteObject(bitmap.into());
                copied.then(|| Frame { width: width as u32, height: height as u32, bgra: pixels })
            }
            _ => None,
        };
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        frame
    }
}

/// Writes `frame` as a PNG at `path`.
pub fn write_png(frame: &Frame, path: &Path) -> Result<(), String> {
    let err = |what: &'static str| move |e: ::windows::core::Error| format!("{what}: {:#010x}", e.code().0);
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(err("imaging"))?;
        let stream = factory.CreateStream().map_err(err("stream"))?;
        stream
            .InitializeFromFilename(&HSTRING::from(path.as_os_str()), GENERIC_WRITE.0)
            .map_err(err("file"))?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()).map_err(err("encoder"))?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache).map_err(err("encoder"))?;
        let mut target = None;
        let mut options = None;
        encoder.CreateNewFrame(&mut target, &mut options).map_err(err("frame"))?;
        let target = target.ok_or("frame")?;
        target.Initialize(options.as_ref()).map_err(err("frame"))?;
        target.SetSize(frame.width, frame.height).map_err(err("size"))?;
        let mut format = GUID_WICPixelFormat32bppBGRA;
        target.SetPixelFormat(&mut format).map_err(err("format"))?;
        target.WritePixels(frame.height, frame.width * 4, &frame.bgra).map_err(err("pixels"))?;
        target.Commit().map_err(err("commit"))?;
        encoder.Commit().map_err(err("commit"))?;
    }
    Ok(())
}

/// Puts `frame` on the clipboard as a device-independent bitmap (CF_DIB),
/// which every app that pastes images reads.
pub fn to_clipboard(frame: &Frame) -> Result<(), String> {
    /// CF_DIB.
    const DIB: u32 = 8;
    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: frame.width as i32,
        // Positive: bottom-up, the form every reader of CF_DIB expects.
        biHeight: frame.height as i32,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: frame.bgra.len() as u32,
        ..Default::default()
    };
    let rows = bottom_up(frame);
    let head = std::mem::size_of::<BITMAPINFOHEADER>();
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, head + rows.len()).map_err(|_| "out of memory")?;
        let at = GlobalLock(memory) as *mut u8;
        if at.is_null() {
            return Err("out of memory".into());
        }
        std::ptr::copy_nonoverlapping(&header as *const BITMAPINFOHEADER as *const u8, at, head);
        std::ptr::copy_nonoverlapping(rows.as_ptr(), at.add(head), rows.len());
        let _ = GlobalUnlock(memory);
        OpenClipboard(None).map_err(|_| "the clipboard is busy")?;
        let _ = EmptyClipboard();
        // Once set, the clipboard owns the memory.
        let set = SetClipboardData(DIB, Some(HANDLE(memory.0)));
        let _ = CloseClipboard();
        set.map(|_| ()).map_err(|_| "the clipboard refused the image".into())
    }
}

/// Brings back the window that was in front and sends it Ctrl+V.
pub fn paste_into(window: Option<isize>) -> Result<(), String> {
    if let Some(raw) = window {
        let hwnd = HWND(raw as *mut _);
        unsafe {
            if IsWindow(Some(hwnd)).as_bool() {
                // Allowed: the click on the island's card was the last input.
                let _ = SetForegroundWindow(hwnd);
            }
        }
        // Let it take the keyboard before the keys arrive.
        std::thread::sleep(Duration::from_millis(150));
    }
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                ..Default::default()
            },
        },
    };
    let v = VIRTUAL_KEY(b'V' as u16);
    let keys = [key(VK_CONTROL, false), key(v, false), key(v, true), key(VK_CONTROL, true)];
    let sent = unsafe { SendInput(&keys, std::mem::size_of::<INPUT>() as i32) };
    // An elevated window refuses input from a normal one (UIPI).
    if sent as usize == keys.len() {
        Ok(())
    } else {
        Err("that window does not take Peika's keys; the image is on the clipboard".into())
    }
}
