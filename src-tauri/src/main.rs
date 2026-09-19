// 阻止 Windows 发布版弹出多余的控制台窗口，请勿删除！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    inkwell_lib::run();
}
