//! 任务取消：native 侧是硬取消（信号 + 进程树），也是 `capabilities().cancel.hard == true` 的来源。
//!
//! 任务表用 `Mutex<HashMap<TaskId, TaskCancel>>`，`TaskId` 由前端生成（`t-xxxxxxxx`）。
//! 取消分两步：先置标志（让 core 在阶段边界退出），再 kill 子进程树（让 ffmpeg 立刻停）。

use media_ports::CancelToken;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 单个任务的取消句柄。
#[derive(Debug, Clone, Default)]
pub struct TaskCancel {
    flag: Arc<AtomicBool>,
}

impl TaskCancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn reset(&self) {
        self.flag.store(false, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub fn handle(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}

impl CancelToken for TaskCancel {
    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// 全局任务表（进程内单例）。
pub struct TaskRegistry {
    map: Mutex<HashMap<String, TaskCancel>>,
}

fn registry() -> &'static TaskRegistry {
    static R: OnceLock<TaskRegistry> = OnceLock::new();
    R.get_or_init(|| TaskRegistry {
        map: Mutex::new(HashMap::new()),
    })
}

impl TaskRegistry {
    pub fn global() -> &'static TaskRegistry {
        registry()
    }

    /// 注册任务；重复 id 会覆盖（前端重试时复用 id 是允许的）。
    pub fn register(&self, task_id: &str) -> TaskCancel {
        let t = TaskCancel::new();
        self.map
            .lock()
            .unwrap()
            .insert(task_id.to_string(), t.clone());
        t
    }

    pub fn get(&self, task_id: &str) -> Option<TaskCancel> {
        self.map.lock().unwrap().get(task_id).cloned()
    }

    /// 取消任务。返回 `true` 表示任务存在。
    pub fn cancel(&self, task_id: &str) -> bool {
        match self.map.lock().unwrap().get(task_id) {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    /// 任务结束（成功/失败/取消）后必须调用，否则 map 会泄漏。
    pub fn unregister(&self, task_id: &str) -> Option<TaskCancel> {
        self.map.lock().unwrap().remove(task_id)
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 取消所有任务（退出应用时）。
    pub fn cancel_all(&self) {
        for t in self.map.lock().unwrap().values() {
            t.cancel();
        }
    }
}

/// RAII 守卫：作用域结束时自动从任务表移除，避免忘记 unregister。
pub struct TaskGuard {
    task_id: String,
    token: TaskCancel,
}

impl TaskGuard {
    pub fn new(task_id: impl Into<String>) -> Self {
        let task_id = task_id.into();
        let token = TaskRegistry::global().register(&task_id);
        TaskGuard { task_id, token }
    }

    pub fn token(&self) -> &TaskCancel {
        &self.token
    }
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        TaskRegistry::global().unregister(&self.task_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_cancel() {
        let reg = TaskRegistry::global();
        let id = "t-test-cancel-1";
        let t = reg.register(id);
        assert!(!t.is_cancelled());
        assert!(reg.cancel(id));
        assert!(t.is_cancelled());
        reg.unregister(id);
    }

    #[test]
    fn cancel_unknown_returns_false() {
        assert!(!TaskRegistry::global().cancel("t-does-not-exist"));
    }

    #[test]
    fn guard_removes_on_drop() {
        let reg = TaskRegistry::global();
        {
            let _g = TaskGuard::new("t-guard-test");
            assert!(reg.get("t-guard-test").is_some());
        }
        assert!(reg.get("t-guard-test").is_none());
    }

    #[test]
    fn task_cancel_satisfies_trait() {
        let t = TaskCancel::new();
        assert!(t.check().is_ok());
        t.cancel();
        assert!(t.check().is_err());
    }

    #[test]
    fn cancel_all_flips_everything() {
        let reg = TaskRegistry::global();
        let a = reg.register("t-all-a");
        let b = reg.register("t-all-b");
        reg.cancel_all();
        assert!(a.is_cancelled() && b.is_cancelled());
        reg.unregister("t-all-a");
        reg.unregister("t-all-b");
    }
}
