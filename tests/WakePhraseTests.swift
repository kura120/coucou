import Foundation

// MARK: - WakePhrase tests (pure functions, no concurrency)

@main
enum WakePhraseTests {

    static var failures = 0

    static func main() {
        // MARK: split — should match

        // Basic wake phrases (no command)
        checkMatch("ok peika",              WakePhrase.split("ok peika"),              cmd: "")
        checkMatch("OK PEIKA",              WakePhrase.split("OK PEIKA"),              cmd: "")
        checkMatch("okay peika",            WakePhrase.split("okay peika"),            cmd: "")
        checkMatch("ok kuku",                WakePhrase.split("ok kuku"),                cmd: "")
        checkMatch("ok cou cou",             WakePhrase.split("ok cou cou"),             cmd: "")
        checkMatch("hey peika",             WakePhrase.split("hey peika"),             cmd: "")
        checkMatch("Hey Peika",             WakePhrase.split("Hey Peika"),             cmd: "")

        // Command extracted from original text (casing/punctuation preserved)
        checkMatch("Okay, Peika, ajoute GitHub",
                   WakePhrase.split("Okay, Peika, ajoute GitHub"),             cmd: "ajoute GitHub")
        checkMatch("ok cuckoo add github",
                   WakePhrase.split("ok cuckoo add github"),                    cmd: "add github")
        checkMatch("ok peika ouvre figma",
                   WakePhrase.split("ok peika ouvre figma"),                   cmd: "ouvre figma")

        // Apostrophes, hyphens and accents preserved in command
        checkMatch("OK Peika, mets l'album de Daft Punk",
                   WakePhrase.split("OK Peika, mets l'album de Daft Punk"),   cmd: "mets l'album de Daft Punk")
        checkMatch("ok peika qu'est-ce que fait Claude ?",
                   WakePhrase.split("ok peika qu'est-ce que fait Claude ?"),  cmd: "qu'est-ce que fait Claude ?")

        // Wake anywhere in transcript (word-boundary search)
        checkMatch("euh ok peika mets de la musique",
                   WakePhrase.split("euh ok peika mets de la musique"),        cmd: "mets de la musique")
        checkMatch("la chanson dit ok peika",
                   WakePhrase.split("la chanson dit ok peika"),                cmd: "") // accepted false positive

        // LAST occurrence wins
        checkMatch("ok peika search ok peika play music",
                   WakePhrase.split("ok peika search ok peika play music"),   cmd: "play music")

        // Partial word-by-word delivery
        checkNoMatch("ok alone",             WakePhrase.split("ok"))
        checkMatch("ok peika partial",      WakePhrase.split("ok peika"),              cmd: "")
        checkMatch("ok peika with more",    WakePhrase.split("ok peika mets"),         cmd: "mets")

        // MARK: split — should NOT match
        checkNoMatch("standalone peika",    WakePhrase.split("peika"))
        checkNoMatch("standalone PEIKA",    WakePhrase.split("PEIKA"))
        checkNoMatch("partial peika ça va", WakePhrase.split("peika ça va"))
        checkNoMatch("peika comment",       WakePhrase.split("peika comment tu vas"))
        checkNoMatch("ok google",            WakePhrase.split("ok google"))
        checkNoMatch("hey siri",             WakePhrase.split("hey siri"))
        checkNoMatch("okkkk peika",         WakePhrase.split("okkkk peika"))
        checkNoMatch("empty",                WakePhrase.split(""))

        // Summary
        if failures == 0 { print("\n\(total)/\(total) tests passed.") }
        else { print("\n\(failures) test(s) FAILED."); exit(1) }
    }

    static var total = 0

    static func checkMatch(_ label: String, _ r: WakePhrase.SplitResult, cmd: String) {
        total += 1
        if !r.matched {
            print("✗  \(label) — expected match, got no match"); failures += 1; return
        }
        if r.command != cmd {
            print("✗  \(label) — matched ✓ but command \"\(r.command)\" ≠ \"\(cmd)\""); failures += 1; return
        }
        print("✓  \(label)")
    }

    static func checkNoMatch(_ label: String, _ r: WakePhrase.SplitResult) {
        total += 1
        if r.matched { print("✗  \(label) — expected no match, got matched (cmd: \"\(r.command)\")"); failures += 1 }
        else         { print("✓  \(label)") }
    }
}
