//! DeepCode Desktop 二进制入口：仅转调库层 `run()`，
//! 逻辑全部放 lib.rs 以便 `tauri::test` 场景复用。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    deepcode_desktop_lib::run();
}
