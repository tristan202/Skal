// Skjuler konsolvinduet i release-builds på Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    skal_lib::run()
}
