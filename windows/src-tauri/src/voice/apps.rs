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
    // "flight": the "gh" is not said.
    let letters: Vec<char> = compact(text)
        .replace("ght", "t")
        .replace("th", "t")
        .replace("ph", "f")
        .replace("ck", "k")
        .replace("qu", "k")
        .replace('x', "ks")
        .chars()
        .collect();
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

//// By letters alone three in ten may be wrong, no more: "photoshop" is not Photos.
const BY_LETTERS: f32 = 0.7;
/// By sound one in four: "this squad" (`tskt`) is near Discord (`tskrt`).
const BY_SOUND: f32 = 0.75;
/// A few words inside a longer sentence must be nearly the name itself.
const NEAR_INSIDE: f32 = 0.9;
/// The nearest app is "clearly" the one when the next is this much further.
const AHEAD: f32 = 0.15;
/// The most apps `near` gives.
const MOST_NEAR: usize = 3;
/// Under this many sounds a sound key says too little to compare.
const SHORTEST_KEY: usize = 4;

/// How alike two names without spaces are by their letters, 0…1; nothing
/// under `BY_LETTERS`.
fn spelt_alike(heard: &str, name: &str) -> f32 {
    let (a, b) = (heard.chars().count(), name.chars().count());
    if a.min(b) == 0 {
        return 0.0;
    }
    let alike = 1.0 - edits(heard, name) as f32 / a.max(b) as f32;
    if alike >= BY_LETTERS { alike } else { 0.0 }
}

/// How alike two names without spaces are, 0…1, or nothing when they are not:
/// by their letters, by how they sound, or — a recogniser also puts sounds in
/// another order, "spy flight" for Spotify — by having the same few sounds
/// after the same start.
fn alike(heard: &str, name: &str) -> f32 {
    let mut best = spelt_alike(heard, name);
    let (heard, name) = (sound(heard), sound(name));
    let (short, long) = (heard.len().min(name.len()), heard.len().max(name.len()));
    if short < SHORTEST_KEY {
        return best;
    }
    let by_sound = 1.0 - edits(&heard, &name) as f32 / long as f32;
    if by_sound >= BY_SOUND {
        best = best.max(by_sound);
    }
    // Short names only: six sounds are found in any order in too many sentences.
    if long <= 5 && long - short <= 1 && heard.as_bytes()[..2] == name.as_bytes()[..2] {
        let mut left: Vec<char> = name.chars().collect();
        let shared = heard.chars().filter(|c| left.iter().position(|l| l == c).map(|at| left.swap_remove(at)).is_some()).count();
        if shared == short {
            best = best.max(0.85 * shared as f32 / long as f32);
        }
    }
    best
}

/// The installed apps nearest to what was heard, nearest first, at most three,
/// each with how near it is (0…1) — for a question, never to be opened as
/// they are. Wider than `find`: "spy flight" is near Spotify, "this squad" near
/// Discord. In a longer sentence ("up in spotify") a few words in a row that
/// are all but a name count too. Nothing near is an empty list.
pub fn near<'a>(said: &str, apps: &'a [App]) -> Vec<(f32, &'a App)> {
    let wanted = normalise(said);
    let words: Vec<&str> = wanted.split(' ').filter(|w| !w.is_empty()).collect();
    if words.is_empty() || words.len() > 12 {
        return Vec::new();
    }
    let whole = words.concat();
    // Every run of one to four words inside it.
    let mut inside: Vec<String> = Vec::new();
    for size in 1..=4.min(words.len() - 1) {
        inside.extend(words.windows(size).map(|run| run.concat()).filter(|run| run.chars().count() >= SHORTEST_GUESS));
    }

    let mut found: Vec<(f32, &App)> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for app in apps {
        let name = normalise(&app.name);
        if name.is_empty() || seen.contains(&name) {
            continue;
        }
        let joined = name.replace(' ', "");
        let mut best = 0.0f32;
        if whole.chars().count() >= SHORTEST_GUESS {
            best = alike(&whole, &joined);
            // As `find` reads a name: its start, or its words in any order.
            if name.starts_with(&wanted) {
                best = best.max(0.9);
            } else if words.iter().all(|w| name.split(' ').any(|have| have == *w)) {
                best = best.max(0.85);
            }
            // A name of several words is also known by one of them, spelt nearly right.
            for word in name.split(' ').filter(|word| word.len() >= SHORTEST_GUESS && *word != name) {
                best = best.max(0.9 * spelt_alike(&whole, word));
            }
        }
        for run in &inside {
            let score = alike(run, &joined);
            if score >= NEAR_INSIDE {
                best = best.max(score);
            }
        }
        if best > 0.0 {
            seen.push(name);
            found.push((best, app));
        }
    }
    // Nearest first; as near, the shorter name, then the alphabet: the same list every time.
    found.sort_by(|(a, x), (b, y)| b.total_cmp(a).then(x.name.len().cmp(&y.name.len())).then(x.name.cmp(&y.name)));
    found.truncate(MOST_NEAR);
    found
}

// Whether the nearest of them is the one to ask about by itself: alone, or
/// clearly nearer than the next.
pub fn clear(near: &[(f32, &App)]) -> bool {
    match near {
        [] => false,
        [_] => true,
        [(first, _), (second, _), ..] => first - second >= AHEAD,
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

/// Listing the apps takes a quarter of a second: one sentence that looks a
/// name up twice, and the answer to "did you mean", read the same list.
const LISTED_FOR: std::time::Duration = std::time::Duration::from_secs(20);

static LISTED: std::sync::Mutex<Option<(std::time::Instant, std::sync::Arc<Vec<App>>)>> = std::sync::Mutex::new(None);

/// `installed`, read again only when the last reading is a while old.
pub fn installed_lately() -> std::sync::Arc<Vec<App>> {
    let mut listed = LISTED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    match listed.as_ref() {
        Some((at, apps)) if at.elapsed() < LISTED_FOR => apps.clone(),
        _ => {
            let apps = std::sync::Arc::new(installed());
            *listed = Some((std::time::Instant::now(), apps.clone()));
            apps
        }
    }
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
    fn the_nearest_apps_to_a_misheard_name_are_ranked_for_a_question() {
        let list = apps(&[
            "Discord", "Figma", "Spotify", "Steam", "Slack", "Notion", "Visual Studio Code", "Visual Studio 2022", "Google Chrome",
            "Calculator", "Notepad", "Paint", "Settings", "Microsoft Edge", "File Explorer", "Task Manager", "Snipping Tool", "Photos",
        ]);
        let names = |said: &str| near(said, &list).iter().map(|(_, app)| app.name.as_str()).collect::<Vec<_>>();
        let first = |said: &str| names(said).first().copied();
        // What Parakeet 0.6b wrote for the user's own voice (doc/voice.md 7.7, and the test of 2026-10-11).
        assert_eq!(first("spy flight"), Some("Spotify"));
        assert_eq!(first("spy-flight"), Some("Spotify"));
        assert_eq!(first("this squad"), Some("Discord"));
        assert_eq!(first("the squad"), Some("Discord"));
        assert_eq!(first("up in spotify"), Some("Spotify"));
        assert_eq!(first("upton spotify"), Some("Spotify"));
        assert_eq!(first("fine figma"), Some("Figma"));
        // Each of those is one app clearly ahead: asked about by itself.
        for said in ["spy flight", "this squad", "the squad", "up in spotify"] {
            assert!(clear(&near(said, &list)), "{said}: {:?}", names(said));
        }
        // Two as near as each other: both, to choose between.
        assert_eq!(names("visual studio"), ["Visual Studio 2022", "Visual Studio Code"]);
        assert!(!clear(&near("visual studio", &list)));
        // What `find` finds is nearest here too.
        assert_eq!(first("this cord"), Some("Discord"));
        assert_eq!(first("chrome"), Some("Google Chrome"));
        assert_eq!(first("Steam"), Some("Steam"));
        // Nothing near: no question to ask.
        for said in [
            "ocean", "the weather", "photoshop", "", "...", "it", "the", "next track", "never mind", "what is two plus two",
            "remind me in twenty minutes", "what is playing", "yeah allow it", "no decline that", "github dot com",
        ] {
            assert_eq!(names(said), Vec::<&str>::new(), "{said}");
        }
        assert!(near("spotify", &[]).is_empty());
        // At most three, and the same app once.
        let many = apps(&["Notes", "Notes 2", "Notes 3", "Notes 4", "Notes"]);
        assert_eq!(near("notes", &many).len(), MOST_NEAR);
        assert_eq!(near("notes", &many)[0].1.name, "Notes");
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

    /// What this machine lists, without the names: how many apps, how long the
    /// listing takes, and whether `COUCOU_VOICE_APP` (names as they might be
    /// heard, separated by `;`) finds one, or which are near.
    /// `cargo test -p coucou voice::apps -- --ignored --nocapture`
    #[test]
    #[cfg(windows)]
    #[ignore = "reads the apps installed on this machine"]
    fn windows_lists_its_apps_store_apps_included() {
        let started = std::time::Instant::now();
        let listed = listed().expect("the Applications folder");
        let took = started.elapsed();
        let store = listed.iter().filter(|app| app.path.to_string_lossy().contains('!')).count();
        println!("{} apps listed in {took:?}, {store} of them from the Store, {} sayable", listed.len(), sayable(&listed).len());
        assert!(listed.len() > 10);
        assert!(listed.iter().all(|app| app.path.to_string_lossy().starts_with("shell:AppsFolder\\")));
        for said in std::env::var("COUCOU_VOICE_APP").unwrap_or_default().split(';').filter(|said| !said.trim().is_empty()) {
            let started = std::time::Instant::now();
            let near = near(said, &listed);
            let took = started.elapsed();
            let names: Vec<String> = near.iter().map(|(score, app)| format!("{} {score:.2}", app.name)).collect();
            println!("{said:?} is {:?}; near ({took:?}, clear: {}): {names:?}", find(said, &listed).map(|app| &app.name), clear(&near));
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
