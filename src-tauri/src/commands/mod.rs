pub mod image;
pub mod office;
pub mod probe;
pub mod video;

use media_native::cancel::TaskRegistry;
use media_ports::ToolError;

/// 取消任务：置标志 + （若有子进程）kill 进程树。
#[tauri::command]
pub fn cancel_task(task_id: String) -> Result<(), ToolError> {
    let reg = TaskRegistry::global();
    if reg.cancel(&task_id) {
        Ok(())
    } else {
        // 任务已结束或不存在 —— 幂等，不报错（取消是幂等操作）
        Ok(())
    }
}

/// sidecar 状态（供「关于」与设置页显示）。
#[tauri::command]
pub fn sidecar_info() -> Result<serde_json::Value, ToolError> {
    Ok(crate::sidecar::info())
}
