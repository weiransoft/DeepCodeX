/// 构建脚本：调用 tauri_build 生成壳工程所需的权限 schema 与资源清单。
///
/// 与默认写法的唯一差别：**不让 tauri-build 塞 Windows 应用清单**，
/// 改由本脚本把同一份清单链进**所有**目标（含 lib 单元测试二进制）。
/// 原因是 tauri-build 只把清单编进 bin（`rustc-link-arg-bins`），
/// 而测试 exe 没有清单会在 Windows 上启动即崩，详见
/// `embed_manifest_for_all_targets` 的说明。
fn main() {
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("tauri-build 执行失败：{error:#}");
    }

    embed_manifest_for_all_targets();
}

/// 把 Common Controls v6 清单链进**所有**链接目标（bin / lib 单元测试 / bench / example）。
///
/// 背景：`cargo test --lib` 在 Windows 上进程一启动就 `0xc0000139
/// STATUS_ENTRYPOINT_NOT_FOUND`（本机 GNU 与 GitHub runner 的 MSVC 都复现，
/// 与工具链无关）。根因是 tauri 生态的已知问题
/// （tauri-apps/tauri#13419 / #14580）：tauri / tray-icon 静态引用了只存在于
/// Common Controls v6 的入口点，而 Windows 只按 exe **自带清单**决定加载
/// ComCtl32 v5 还是 v6 —— 测试 exe 没有清单就按 v5 加载，导入解析失败，
/// 进程还没跑到第一个用例就退出。tauri-build 恰好只把清单编进 bin，
/// 测试二进制永远是裸的。
///
/// 做法：
/// 1. 主函数里用 `Attributes::new_without_app_manifest()` 让 tauri-build 不再
///    自己嵌清单（否则同一 exe 出现两个 RT_MANIFEST，链接器报 `CVT1100`）；
/// 2. 这里生成只含 `1 24 "清单.xml"` 的 .rc，用 embed-resource 编译后经
///    `rustc-link-arg`（对所有目标生效）链进去。
///
/// 走 .rc 而不是 link.exe 的 `/MANIFEST:EMBED`+`/MANIFESTINPUT`，是为了
/// GNU 也能生效（GNU 走 ld，不认前者的参数）；embed-resource 在 MSVC 下
/// 用 rc.exe、GNU 下用 windres，同一份代码覆盖两条工具链。
fn embed_manifest_for_all_targets() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 由 cargo 注入"),
    )
    .join("windows-test-manifest.xml");

    println!("cargo:rerun-if-changed={}", manifest.display());

    // 清单内容与 tauri-build 自带的那份逐字节一致（只有 Common Controls v6 依赖），
    // 换的只是"谁来嵌、嵌给谁"。
    let rc = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 由 cargo 注入"))
        .join("app-manifest.rc");
    std::fs::write(&rc, format!("1 24 \"{}\"\n", manifest.display()))
        .expect("写出清单 .rc 失败");

    // 1 = 资源 ID，24 = RT_MANIFEST。资源文件由本脚本生成，故用 NONE 传参。
    match embed_resource::compile_for_everything(&rc, embed_resource::NONE) {
        embed_resource::CompilationResult::Ok | embed_resource::CompilationResult::NotWindows => {}
        embed_resource::CompilationResult::NotAttempted(tool) => {
            // 工具缺失（如 GNU 下 windres 不在 PATH）不让 build 直接失败，
            // 只告警：此时行为退回修复前（测试 exe 无清单）。
            println!(
                "cargo:warning=应用清单未嵌入：找不到资源编译器 {tool}（PATH 里补 windres / rc.exe 后重试）"
            );
        }
        embed_resource::CompilationResult::Failed(err) => {
            println!("cargo:warning=应用清单嵌入失败（{err}），本次构建的资源里没有清单");
        }
    }
}
