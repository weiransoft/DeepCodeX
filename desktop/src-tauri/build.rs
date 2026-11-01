/// 构建脚本：调用 tauri_build 生成壳工程所需的权限 schema 与资源清单。
fn main() {
    tauri_build::build()
}
