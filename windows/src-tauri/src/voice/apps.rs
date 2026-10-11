// "Open Figma", "open my downloads": what voice may open. Only what the Start
// menu lists and a few folders of the user's own — a name is looked up, never
// run: nothing here takes a path or a command line from what was said.
//
// The apps are the ones Windows itself lists under "All apps" (its Applications
// folder), Microsoft Store apps included; the Start menu's shortcut files are
// read where that list cannot be. And a name is matched the way it was heard:
// "this cord" is Discord.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct App {
    pub name: String,
    pub path: PathBuf,
}

impl App {
    /// Starts it, through the shell that listed it.
    pub fn open(&self) {
        crate::platform::reveal_folder(&self.path.to_string_lossy());
    }
}

fn normalise(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// A name with nothing between its letters: "this cord" and "Discord" are
/// then two letters apart.
fn compact(text: &str) -> String {
    normalise(text).replace(' ', "")
}

/// How a name sounds, roughly: its consonants, those a recogniser takes for
/// one another made the same. "this cord" and "Discord" are both `tskrt`.
fn sound(text: &str) -> String {
    let letters: Vec<char> =
        compact(text).replace("th", "t").replace("ph", "f").replace("ck", "k").replace("qu", "k").replace('x', "ks").chars().collect();
    let mut out = String::new();
    for (i, c) in letters.iter().enumerate() {
        let soft = matches!(letters.get(i + 1), Some('e' | 'i' | 'y'));
        let key = match c {
            'a' | 'e' | 'i' | 'o' | 'u' | 'y' | 'h' | 'w' => {
                // Only where a name starts with one.
                if i > 0 {
                    continue;
                }
                'a'
            }
            'b' | 'p' => 'p',
            'd' | 't' => 't',
            'c' if soft => 's',
            'c' | 'g' | 'k' | 'q' => 'k',
            'f' | 'v' => 'f',
            's' | 'z' => 's',
            'm' | 'n' => 'n',
            other => *other,
        };
        if !out.ends_with(key) {
            out.push(key);
        }
    }
    out
}

/// How many letters to add, drop or change to make one name the other.
fn edits(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if ca == cb { diagonal } else { 1 + diagonal.min(above).min(row[j]) };
            diagonal = above;
        }
    }
    row[b.len()]
}

/// Under this many letters a name is too short to be guessed at.
const SHORTEST_GUESS: usize = 4;

/// The app `said` means: its name exactly, else the only one whose name
/// starts with it, else the only one that has all its words — else what it
/// was heard as: the only one that sounds the same, or the one closest by a
/// letter or two. Two apps as close as each other is no app.
pub fn find<'a>(said: &str, apps: &'a [App]) -> Option<&'a App> {
    let wanted = normalise(said);
    if wanted.is_empty() {
        return None;
    }
    let named: Vec<(String, &App)> = apps.iter().map(|app| (normalise(&app.name), app)).collect();
    if let Some((_, app)) = named.iter().find(|(name, _)| *name == wanted) {
        return Some(app);
    }
    let only = |matches: Vec<&'a App>| if matches.len() == 1 { Some(matches[0]) } else { None };
    let starting: Vec<&App> = named.iter().filter(|(name, _)| name.starts_with(&wanted)).map(|(_, app)| *app).collect();
    if !starting.is_empty() {
        return only(starting);
    }
    let words: Vec<&str> = wanted.split(' ').collect();
    let worded: Vec<&App> = named
        .iter()
        .filter(|(name, _)| {
            let have: Vec<&str> = name.split(' ').collect();
            words.iter().all(|w| have.contains(w))
        })
        .map(|(_, app)| *app)
        .collect();
    if !worded.is_empty() {
        return only(worded);
    }

    // Misheard: "this cord", "fig ma", "spot a fly".
    let heard = compact(&wanted);
    if heard.chars().count() < SHORTEST_GUESS {
        return None;
    }
    let key = sound(&heard);
    let sounding: Vec<&App> = named.iter().filter(|(name, _)| key.len() >= 3 && sound(name) == key).map(|(_, app)| *app).collect();
    if !sounding.is_empty() {
        return only(sounding);
    }
    // One letter in four may be wrong, and no other app may be as close.
    let allowed = (heard.chars().count() / 4).max(1);
    let mut close: Vec<(usize, &App)> =
        named.iter().map(|(name, app)| (edits(&heard, &compact(name)), *app)).filter(|(far, _)| *far <= allowed).collect();
    close.sort_by_key(|(far, _)| *far);
    match close.as_slice() {
        [(_, app)] => Some(app),
        [(nearest, app), (next, _), ..] if nearest < next => Some(app),
        _ => None,
    }
}

/// Shortcuts that are not the app itself.
fn is_noise(name: &str) -> bool {
    let name = name.to_lowercase();
    ["uninstall", "readme", "release notes", "documentation", "help", "license", "website", "manual"]
        .iter()
        .any(|word| name.contains(word))
}

fn collect(dir: &Path, depth: u32, into: &mut Vec<App>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < 3 {
                collect(&path, depth + 1, into);
            }
        } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
            if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                if !is_noise(name) {
                    into.push(App { name: name.to_string(), path: path.clone() });
                }
            }
        }
    }
}

/// What Windows lists under "All apps": its Applications folder, where every
/// app has a name and an identifier the shell can start — a Start-menu
/// shortcut's program as much as a Microsoft Store app. None when the shell
/// will not list it.
#[cfg(windows)]
fn listed() -> Option<Vec<App>> {
    use windows::core::PWSTR;
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, SHGetKnownFolderItem, KF_FLAG_DEFAULT,
        SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
    };
    unsafe fn text(name: windows::core::Result<PWSTR>) -> Option<String> {
        let name = name.ok()?;
        let text = unsafe { name.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(name.0.cast())) };
        text.filter(|text| !text.is_empty())
    }
    unsafe {
        // Balanced below when it was this call that set COM up on the thread.
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let apps = (|| {
            let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None).ok()?;
            let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems).ok()?;
            let mut apps = Vec::new();
            loop {
                let mut one = [None];
                let mut got = 0u32;
                if items.Next(&mut one, Some(&mut got)).is_err() || got == 0 {
                    break;
                }
                let Some(item) = one[0].take() else { break };
                let (Some(name), Some(id)) = (text(item.GetDisplayName(SIGDN_NORMALDISPLAY)), text(item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING)))
                else {
                    continue;
                };
                // A link to a web page or a document is not an app.
                if is_noise(&name) || id.contains("://") {
                    continue;
                }
                apps.push(App { name, path: PathBuf::from(format!("shell:AppsFolder\\{id}")) });
            }
            Some(apps)
        })();
        if com {
            CoUninitialize();
        }
        apps.filter(|apps| !apps.is_empty())
    }
}

/// The apps voice may open: what Windows lists, or the Start menu's shortcut
/// files (the user's own first) where it lists nothing.
#[cfg(windows)]
pub fn installed() -> Vec<App> {
    if let Some(apps) = listed() {
        return apps;
    }
    let mut apps = Vec::new();
    for var in ["APPDATA", "ProgramData"] {
        if let Some(base) = std::env::var_os(var) {
            collect(&PathBuf::from(base).join("Microsoft/Windows/Start Menu/Programs"), 0, &mut apps);
        }
    }
    apps
}

/// The most names a recogniser that only hears what it was given is given.
const MOST_SAID: usize = 200;

/// The apps' names as they can be said to such a recogniser: plain lowercase
/// words, a few of them, each name once.
pub fn sayable(apps: &[App]) -> Vec<String> {
    let mut names: Vec<String> = apps
        .iter()
        .map(|app| normalise(&app.name))
        .filter(|name| {
            let words: Vec<&str> = name.split(' ').collect();
            !name.is_empty() && words.len() <= 4 && words.iter().all(|w| w.len() <= 24 && w.is_ascii())
        })
        .collect();
    names.sort();
    names.dedup();
    names.truncate(MOST_SAID);
    names
}

#[cfg(not(windows))]
pub fn installed() -> Vec<App> {
    Vec::new()
}

/// One of the user's folders by its everyday name, when it exists.
pub fn folder(said: &str) -> Option<(String, PathBuf)> {
    let wanted = normalise(said);
    let name = ["Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos"].into_iter().find(|name| {
        let lower = name.to_lowercase();
        wanted.split(' ').any(|w| w == lower || format!("{w}s") == lower)
    })?;
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE")?;
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join(name);
    path.is_dir().then(|| (name.to_string(), path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps(names: &[&str]) -> Vec<App> {
        names.iter().map(|n| App { name: n.to_string(), path: PathBuf::from(format!("{n}.lnk")) }).collect()
    }

    #[test]
    fn an_app_is_found_by_its_name_its_start_or_its_words() {
        let list = apps(&["Figma", "Visual Studio Code", "Visual Studio 2022", "Google Chrome", "Notion", "Notion Calendar"]);
        let name = |said: &str| find(said, &list).map(|a| a.name.as_str());
        assert_eq!(name("figma"), Some("Figma"));
        assert_eq!(name("  FIGMA. "), Some("Figma"));
        assert_eq!(name("chrome"), Some("Google Chrome"));
        assert_eq!(name("visual studio code"), Some("Visual Studio Code"));
        assert_eq!(name("studio code"), Some("Visual Studio Code"));
        // Its name exactly wins over what starts with it.
        assert_eq!(name("notion"), Some("Notion"));
    }

    #[test]
    fn an_app_is_found_by_what_its_name_was_heard_as() {
        let list = apps(&["Discord", "Figma", "Spotify", "Visual Studio Code", "Visual Studio 2022", "Notion", "Slack", "Steam"]);
        let name = |said: &str| find(said, &list).map(|a| a.name.as_str());
        // What the speech model wrote for "Discord" in the first real test.
        assert_eq!(name("this cord"), Some("Discord"));
        assert_eq!(name("This cord."), Some("Discord"));
        assert_eq!(name("dis chord"), Some("Discord"));
        assert_eq!(name("fig ma"), Some("Figma"));
        assert_eq!(name("sigma"), Some("Figma"));
        assert_eq!(name("spotifi"), Some("Spotify"));
        assert_eq!(name("visual studio coat"), Some("Visual Studio Code"));
        assert_eq!(name("ocean"), None);
        // Too short to guess at, or as close to two apps: no app.
        assert_eq!(name("slk"), None);
        assert_eq!(name("stack"), Some("Slack"));
        assert_eq!(find("steak", &apps(&["Steam", "Steak"])).map(|a| a.name.as_str()), Some("Steak"));
        assert_eq!(find("stead", &apps(&["Steam", "Stear"])), None);
        // A whole other word is not a letter or two away.
        assert_eq!(name("photoshop"), None);
        assert_eq!(name("the weather"), None);
    }

    #[test]
    fn a_name_sounds_like_its_consonants_and_is_letters_away_from_another() {
        assert_eq!(sound("this cord"), sound("Discord"));
        assert_eq!(sound("Discord"), "tskrt");
        assert_eq!(sound("versal"), sound("Vercel"));
        assert_ne!(sound("Figma"), sound("Notion"));
        assert_eq!(edits("thiscord", "discord"), 2);
        assert_eq!(edits("", "abc"), 3);
        assert_eq!(edits("figma", "figma"), 0);
    }

    #[test]
    fn names_for_a_recogniser_are_plain_words_each_once() {
        let list = apps(&["Figma", "figma", "Visual Studio Code", "Caf\u{e9} Notes", "A Very Long Name Of Five Words", "7-Zip File Manager", "…"]);
        assert_eq!(sayable(&list), ["7 zip file manager", "figma", "visual studio code"]);
        let many: Vec<App> = (0..500).map(|i| App { name: format!("App {i}"), path: PathBuf::new() }).collect();
        assert_eq!(sayable(&many).len(), MOST_SAID);
    }

    /// What this machine lists, without the names: how many apps, and whether
    /// `COUCOU_VOICE_APP` (a name as it might be heard) finds one.
    /// `cargo test -p coucou voice::apps -- --ignored --nocapture`
    #[test]
    #[cfg(windows)]
    #[ignore = "reads the apps installed on this machine"]
    fn windows_lists_its_apps_store_apps_included() {
        let listed = listed().expect("the Applications folder");
        let store = listed.iter().filter(|app| app.path.to_string_lossy().contains('!')).count();
        println!("{} apps listed, {store} of them from the Store, {} sayable", listed.len(), sayable(&listed).len());
        assert!(listed.len() > 10);
        assert!(listed.iter().all(|app| app.path.to_string_lossy().starts_with("shell:AppsFolder\\")));
        if let Ok(said) = std::env::var("COUCOU_VOICE_APP") {
            println!("{said:?} is {:?}", find(&said, &listed).map(|app| &app.name));
        }
    }

    /// Starting an app by the identifier Windows lists it under, which is what
    /// `App::open` does and nothing else here shows. `COUCOU_VOICE_LAUNCH`
    /// names the apps, separated by `;` — "Calculator;Character Map" is one
    /// from the Store and one that is not. Each is found, started, and a
    /// window that was not there comes up. It really starts them, and leaves
    /// them open: not for a machine nobody is looking at.
    /// `cargo test -p coucou voice::apps -- --ignored --nocapture`
    #[test]
    #[cfg(windows)]
    #[ignore = "starts the apps it is given"]
    fn an_app_is_started_by_its_identifier() {
        use std::time::{Duration, Instant};
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, IsWindowVisible};

        /// The windows a user can see: visible, with a title.
        fn windows_shown() -> Vec<isize> {
            unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
                unsafe {
                    if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
                        (*(lparam.0 as *mut Vec<isize>)).push(hwnd.0 as isize);
                    }
                }
                BOOL(1)
            }
            let mut list: Vec<isize> = Vec::new();
            unsafe {
                let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut _ as isize));
            }
            list
        }

        let wanted = std::env::var("COUCOU_VOICE_LAUNCH").expect("COUCOU_VOICE_LAUNCH");
        let listed = listed().expect("the Applications folder");
        let (mut store, mut classic) = (0, 0);
        for said in wanted.split(';').map(str::trim).filter(|said| !said.is_empty()) {
            let app = find(said, &listed).unwrap_or_else(|| panic!("{said:?} is not an app Windows lists"));
            let id = app.path.to_string_lossy();
            assert!(id.starts_with("shell:AppsFolder\\"), "{said}");
            // A Store app's identifier is its package and its entry, with a "!" between.
            let from_store = id.contains('!');
            let before = windows_shown();
            app.open();
            let started = Instant::now();
            let mut came = false;
            while !came && started.elapsed() < Duration::from_secs(20) {
                std::thread::sleep(Duration::from_millis(250));
                came = windows_shown().iter().any(|window| !before.contains(window));
            }
            println!(
                "{:?} ({}): {}",
                app.name,
                if from_store { "from the Store" } else { "not from the Store" },
                if came { format!("a window came up after {:?}", started.elapsed()) } else { "no window came up".to_string() }
            );
            assert!(came, "{said}: nothing opened");
            if from_store {
                store += 1;
            } else {
                classic += 1;
            }
            // The next one's window is not to be taken for this one's.
            std::thread::sleep(Duration::from_secs(2));
        }
        println!("{store} from the Store and {classic} not: give one of each to have checked both");
    }

    #[test]
    fn two_apps_as_close_or_nothing_close_is_no_app() {
        let list = apps(&["Visual Studio Code", "Visual Studio 2022", "Figma"]);
        assert_eq!(find("visual studio", &list), None);
        assert_eq!(find("photoshop", &list), None);
        assert_eq!(find("", &list), None);
        assert_eq!(find("...", &list), None);
        assert_eq!(find("figma", &[]), None);
    }

    #[test]
    fn what_was_said_is_only_ever_a_name_to_look_up() {
        let list = apps(&["Figma"]);
        for said in ["cmd /c calc", "C:\\Windows\\System32\\calc.exe", "figma && calc", "..\\..\\x"] {
            assert_eq!(find(said, &list), None, "{said}");
        }
    }

    #[test]
    fn shortcuts_that_are_not_the_app_are_left_out() {
        assert!(is_noise("Uninstall Figma"));
        assert!(is_noise("Figma Help"));
        assert!(!is_noise("Figma"));
    }

    #[test]
    fn a_folder_is_one_of_the_users_own_by_its_everyday_name() {
        for said in ["a folder", "system32", "", "c:/windows"] {
            assert_eq!(folder(said), None, "{said}");
        }
        // The ones that exist on the machine running the tests are found by name.
        if let Some((name, path)) = folder("my downloads folder") {
            assert_eq!(name, "Downloads");
            assert!(path.ends_with("Downloads"));
        }
        if let Some((name, _)) = folder("the document folder") {
            assert_eq!(name, "Documents");
        }
    }
}
