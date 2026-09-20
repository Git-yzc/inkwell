fn main() {
    // 前端产物变了就必须重新编译本 crate。
    //
    // generate_context! 会把 dist/ 整个内嵌进二进制，但 cargo 默认不跟踪这个目录
    // （tauri-build 只为 sidecar / resources / 配置文件声明 rerun-if-changed），
    // 结果就是「只改了界面、重新出包，装上去还是旧界面」这种很费时间的错觉。
    // 这里显式声明，让 cargo 在 dist 变化时重跑构建脚本并重编本 crate。
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
