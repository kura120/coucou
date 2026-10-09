// The pull requests of the folder Claude Code works in, for the list next to
// the chat's conversations: the open ones on GitHub, and the local branches
// whose work is not in a pull request yet.
//
// Coucou asks the tools the user already has, as for Codex and Claude Code:
// `git` for the branches, and the GitHub CLI (`gh`, with its own sign-in) for
// the pull requests. No token of Coucou's is involved and nothing is written.
// It runs only when the list is opened.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;

use crate::i18n::t;
use crate::platform;

/// The most of each that the list shows.
const MAX_ROWS: usize = 30;

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pulls {
    /// `owner/name` on GitHub, when `origin` points there.
    pub repo: Option<String>,
    /// Open pull requests on GitHub.
    pub remote: Vec<Pull>,
    /// Local branches ahead of the default one, with no pull request yet.
    pub local: Vec<LocalBranch>,
    /// Why the GitHub half is empty, when it is not simply that there are none.
    pub note: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pull {
    pub number: u64,
    pub title: String,
    pub branch: String,
    pub url: String,
    pub draft: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub branch: String,
    /// Commits it has that the default branch has not.
    pub ahead: u32,
    /// It exists on a remote too (but has no pull request).
    pub pushed: bool,
    /// The branch checked out in the folder.
    pub current: bool,
}

/// Runs a tool in `dir` and returns what it printed, or what it complained of.
fn run(exe: &Path, dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(exe);
    cmd.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Never a prompt: a tool that wants one fails instead.
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1");
    platform::no_console(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("").trim().to_string())
    }
}

/// `owner/name` from a GitHub remote address, https or ssh.
fn github_repo(remote: &str) -> Option<String> {
    let rest = remote
        .trim()
        .strip_prefix("https://github.com/")
        .or_else(|| remote.trim().strip_prefix("http://github.com/"))
        .or_else(|| remote.trim().strip_prefix("git@github.com:"))
        .or_else(|| remote.trim().strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = rest.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (parts.next().is_none() && plain(owner) && plain(name)).then(|| format!("{owner}/{name}"))
}

/// The open pull requests from `gh pr list --json …`.
fn parse_pulls(json: &str) -> Vec<Pull> {
    let list: Vec<Value> = serde_json::from_str(json).unwrap_or_default();
    list.iter()
        .filter_map(|p| {
            Some(Pull {
                number: p.get("number")?.as_u64()?,
                title: p.get("title")?.as_str()?.to_string(),
                branch: p.get("headRefName")?.as_str()?.to_string(),
                // Only ever GitHub's own address: the island opens it on a click.
                url: p.get("url")?.as_str().filter(|u| u.starts_with("https://github.com/"))?.to_string(),
                draft: p.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .take(MAX_ROWS)
        .collect()
}

/// `refname<TAB>upstream` lines of `git for-each-ref refs/heads`.
fn parse_branches(lines: &str) -> Vec<(String, bool)> {
    lines
        .lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let name = cols.next()?.trim();
            (!name.is_empty()).then(|| (name.to_string(), !cols.next().unwrap_or("").trim().is_empty()))
        })
        .collect()
}

/// The local half: branches with commits of their own that no open pull
/// request carries, the current one first.
fn local_only(mut branches: Vec<LocalBranch>, remote: &[Pull]) -> Vec<LocalBranch> {
    branches.retain(|b| b.ahead > 0 && !remote.iter().any(|p| p.branch == b.branch));
    branches.sort_by_key(|b| (!b.current, b.branch.clone()));
    branches.truncate(MAX_ROWS);
    branches
}

/// The branch everything is measured against: where origin's HEAD points, or
/// the usual names.
fn default_branch(git: &Path, dir: &Path) -> Option<String> {
    if let Ok(head) = run(git, dir, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        if !head.is_empty() {
            return Some(head);
        }
    }
    ["origin/main", "origin/master", "main", "master"]
        .into_iter()
        .find(|name| run(git, dir, &["rev-parse", "--verify", "--quiet", &format!("{name}^{{commit}}")]).is_ok())
        .map(str::to_string)
}

/// The pull requests of the repository in `dir`. Blocking: call it off the main thread.
pub fn read(dir: &Path) -> Result<Pulls, String> {
    let no_repo = || t("This folder is not a Git repository.");
    let git: PathBuf = platform::find_on_path("git").ok_or_else(no_repo)?;
    run(&git, dir, &["rev-parse", "--show-toplevel"]).map_err(|_| no_repo())?;

    let repo = run(&git, dir, &["remote", "get-url", "origin"]).ok().and_then(|url| github_repo(&url));
    let (remote, note) = match (&repo, platform::find_on_path("gh")) {
        (None, _) => (Vec::new(), Some(t("This repository's origin is not on GitHub."))),
        (Some(_), None) => {
            (Vec::new(), Some(t("Install the GitHub CLI (gh) and sign in to see the pull requests on GitHub.")))
        }
        (Some(repo), Some(gh)) => {
            let limit = MAX_ROWS.to_string();
            let args = ["pr", "list", "--repo", repo, "--state", "open", "--limit", &limit, "--json", "number,title,headRefName,url,isDraft"];
            match run(&gh, dir, &args) {
                Ok(json) => (parse_pulls(&json), None),
                Err(why) => (Vec::new(), Some(if why.is_empty() { t("GitHub did not answer.") } else { why })),
            }
        }
    };

    let current = run(&git, dir, &["branch", "--show-current"]).unwrap_or_default();
    let base = default_branch(&git, dir);
    let mut branches = Vec::new();
    if let Some(base) = &base {
        let base_name = base.strip_prefix("origin/").unwrap_or(base);
        let listed = run(&git, dir, &["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(upstream:short)"])
            .unwrap_or_default();
        for (branch, pushed) in parse_branches(&listed).into_iter().filter(|(b, _)| b != base_name).take(200) {
            let ahead = run(&git, dir, &["rev-list", "--count", &format!("{base}..refs/heads/{branch}")])
                .ok()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            branches.push(LocalBranch { current: branch == current, branch, ahead, pushed });
        }
    }
    Ok(Pulls { repo, local: local_only(branches, &remote), remote, note })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_repository_is_read_from_a_github_remote_and_nothing_else() {
        for url in [
            "https://github.com/kura120/coucou.git",
            "https://github.com/kura120/coucou",
            "git@github.com:kura120/coucou.git\n",
            "ssh://git@github.com/kura120/coucou.git",
        ] {
            assert_eq!(github_repo(url).as_deref(), Some("kura120/coucou"), "{url}");
        }
        for url in [
            "https://gitlab.com/a/b.git",
            "https://github.com/only-owner",
            "https://github.com/a/b/c",
            "https://github.com/a/b --repo x",
            "https://github.com.evil.example/a/b",
            "",
        ] {
            assert_eq!(github_repo(url), None, "{url}");
        }
    }

    #[test]
    fn pull_requests_come_from_gh_s_json_with_github_addresses_only() {
        let json = r#"[
            {"number":7,"title":"Add a thing","headRefName":"feat/thing","url":"https://github.com/o/r/pull/7","isDraft":true},
            {"number":8,"title":"Elsewhere","headRefName":"x","url":"https://example.com/pull/8"},
            {"number":"nine","title":"Broken","headRefName":"y","url":"https://github.com/o/r/pull/9"},
            {"number":10,"title":"Fix","headRefName":"fix/it","url":"https://github.com/o/r/pull/10"}
        ]"#;
        let pulls = parse_pulls(json);
        assert_eq!(pulls.iter().map(|p| (p.number, p.branch.as_str(), p.draft)).collect::<Vec<_>>(), [(7, "feat/thing", true), (10, "fix/it", false)]);
        assert!(parse_pulls("not json").is_empty());
        assert!(parse_pulls("{}").is_empty());
    }

    #[test]
    fn a_local_branch_is_listed_when_it_has_work_and_no_pull_request() {
        assert_eq!(
            parse_branches("main\torigin/main\nfeat/a\torigin/feat/a\nfeat/b\t\nwip\n"),
            [("main".to_string(), true), ("feat/a".to_string(), true), ("feat/b".to_string(), false), ("wip".to_string(), false)]
        );
        let branch = |name: &str, ahead, pushed, current| LocalBranch { branch: name.into(), ahead, pushed, current };
        let remote = parse_pulls(r#"[{"number":1,"title":"t","headRefName":"feat/a","url":"https://github.com/o/r/pull/1"}]"#);
        let local = local_only(
            vec![branch("feat/a", 3, true, false), branch("zeta", 1, false, false), branch("merged", 0, true, false), branch("wip", 2, true, true)],
            &remote,
        );
        // In a pull request, or with nothing of its own: not here. The current branch first.
        assert_eq!(local.iter().map(|b| b.branch.as_str()).collect::<Vec<_>>(), ["wip", "zeta"]);
    }
}
