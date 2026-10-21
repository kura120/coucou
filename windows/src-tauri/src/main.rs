// Peika runs without a console window: Peika is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    peika_lib::run()
}
