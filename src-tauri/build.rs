fn main() {
    #[cfg(target_os = "macos")]
    cc::Build::new()
        .file("src/dock_menu.m")
        .flag("-fobjc-arc")
        .compile("gomavo_dock_menu");
    tauri_build::build()
}
