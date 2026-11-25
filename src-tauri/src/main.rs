// Windows 发布版不弹控制台
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    media_toolbox_lib::run()
}
