// "Open Figma", "open my downloads": what voice may open. Only what the Start
// menu lists and a few folders of the user's own — a name is looked up, never
// run: nothing here takes a path or a command line from what was said.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct App {
    pub name: String,
    pub path: PathBuf,
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

/// The app `said` means: its name exactly, else the only one whose name
/// starts with it, else the only one that has all its words. Two apps as
/// close as each other is no app.
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
    only(
        named
            .iter()
            .filter(|(name, _)| {
                let have: Vec<&str> = name.split(' ').collect();
                words.iter().all(|w| have.contains(w))
            })
            .map(|(_, app)| *app)
            .collect(),
    )
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

/// The Start menu's shortcuts, the user's own first. Apps from the Microsoft
/// Store have none and are not found.
#[cfg(windows)]
pub fn installed() -> Vec<App> {
    let mut apps = Vec::new();
    for var in ["APPDATA", "ProgramData"] {
        if let Some(base) = std::env::var_os(var) {
            collect(&PathBuf::from(base).join("Microsoft/Windows/Start Menu/Programs"), 0, &mut apps);
        }
    }
    apps
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
