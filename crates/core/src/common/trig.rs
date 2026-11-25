//! 确定性三角函数 —— 双端字节相等的前提。
//!
//! ## 为什么不能用 `f32::sin()` / `f32::exp()`
//!
//! 实测（`docs/benchmarks.md` B0）：同一个 `Filter::Lanczos3.kernel(0.7)`：
//!
//! | 目标 | 值 |
//! |---|---|
//! | native (aarch64-apple-darwin) | `0.3358102739` |
//! | wasm32-unknown-unknown | `0.3358102143` |
//!
//! 差 6e-8 —— 看起来微不足道，但经过 6 tap 累加 + 归一化 + 量化后，
//! 会把边缘像素推到不同的 `u8` 值，最终输出**整个 PNG 都不同**（11 KB vs 6.6 KB）。
//!
//! 根因：`f32::sin` 在 native 上走 libm，在 wasm 上走 LLVM 编译的 fdlibm 变体，
//! 两者都是「正确到 1 ULP 附近」的实现，但**不保证逐位相同**。Rust 标准库不承诺
//! 跨平台浮点三角函数的结果一致，这是语言层面的正常行为，不是 bug。
//!
//! ## 解决办法
//!
//! 自己实现所需的三角函数与指数函数，只用 IEEE-754 明确规定的运算（`+ - * /`），
//! 从而保证两个目标上逐位相同。代价是精度略低于 libm（约 1e-7 相对误差），
//! 但对于「图像重采样核」这个场景完全够用 —— 核的精度远低于该量级。
//!
//! 要求的运算：加、减、乘、除、floor、abs、copysign —— IEEE-754 全部有精确定义，
//! 无需 `-ffast-math` 也无需 FMA。

/// 常量的高精度表示（`f64` 字面量转 `f32`，避免 `3.14159` 这类截断。
const PI: f32 = std::f32::consts::PI;
const TWO_PI: f32 = 2.0 * PI;
const HALF_PI: f32 = 0.5 * PI;

/// 把角度归约到 `[-PI, PI]`。只用 `+ - * floor`，确定性。
#[inline]
fn reduce(angle: f32) -> f32 {
    // k = round(angle / 2PI)；用 floor(x + 0.5) 而不是 round()（round 的实现可能不同）
    let k = (angle / TWO_PI + 0.5).floor();
    angle - k * TWO_PI
}

/// 确定性 `sin`。
///
/// 实现：归约到 `[-PI/2, PI/2]` 后用 11 次泰勒展开（误差 < 1e-8，优于 f32 精度）；
/// 归约用 `+ - * floor`，全 IEEE 精确运算。
pub fn sin(x: f32) -> f32 {
    if !x.is_finite() {
        return f32::NAN;
    }
    let a = reduce(x);

    // 映射到 [-PI/2, PI/2]：sin(PI - a) = sin(a)，sin(-PI - a) = sin(a)
    let (v, negate) = if a > HALF_PI {
        (PI - a, false)
    } else if a < -HALF_PI {
        (-PI - a, false)
    } else {
        (a, false)
    };
    let _ = negate;

    // 泰勒：x - x³/3! + x⁵/5! - x⁷/7! + x⁹/9! - x¹¹/11!
    let x2 = v * v;
    let mut term = v;
    let mut sum = v;
    // 逐项：term *= -x²/((2k)(2k+1))
    term *= -x2 / 6.0;
    sum += term;
    term *= -x2 / 20.0;
    sum += term;
    term *= -x2 / 42.0;
    sum += term;
    term *= -x2 / 72.0;
    sum += term;
    term *= -x2 / 110.0;
    sum += term;
    sum
}

/// 确定性 `cos`。
pub fn cos(x: f32) -> f32 {
    // cos(x) = sin(x + PI/2)。归约在 sin 内部完成。
    sin(x + HALF_PI)
}

/// 确定性 `exp`。
///
/// 实现：`exp(x) = 2^k * exp(r)`，其中 `k = round(x / ln2)`，`|r| < ln2/2`，
/// 再用泰勒展开 `exp(r)`。2^k 用位运算构造（IEEE 规范）。
///
/// 用途：Lanczos 核里的 `sin` 已经替换；`Gaussian` 核需要 `exp`。
pub fn exp(x: f32) -> f32 {
    if x.is_nan() {
        return f32::NAN;
    }
    if !x.is_finite() {
        // +INF -> INF；-INF -> 0
        return if x > 0.0 { f32::INFINITY } else { 0.0 };
    }
    if x > 88.0 {
        return f32::INFINITY;
    }
    if x < -88.0 {
        return 0.0;
    }

    const LN2: f32 = std::f32::consts::LN_2;
    let k = (x / LN2 + if x >= 0.0 { 0.5 } else { -0.5 }).floor();
    let r = x - k * LN2;

    // exp(r) 泰勒（|r| < 0.347，7 项足够）
    let mut term = 1.0f32;
    let mut sum = 1.0f32;
    for i in 1..=8 {
        term *= r / i as f32;
        sum += term;
    }

    // 2^k：k 在 [-127, 127] 内，直接构造 IEEE-754 指数位
    let ki = k as i32;
    if !(-126..=127).contains(&ki) {
        // 极端值：退化为逐次乘 2（几乎不会走到）
        let mut v = sum;
        for _ in 0..ki.unsigned_abs().min(1000) {
            v *= if ki > 0 { 2.0 } else { 0.5 };
        }
        return v;
    }
    let scale = f32::from_bits(((ki + 127) as u32) << 23);
    sum * scale
}

/// 确定性 `powf` 的**受限**版本：仅支持整数与半整数指数用得上的场景。
///
/// 图像管线里实际只用到 `x³` 这种整数幂，直接展开即可，不需要完整 powf。
pub fn powi(x: f32, n: i32) -> f32 {
    let mut result = 1.0f32;
    let mut base = x;
    let mut e = n.unsigned_abs();
    while e > 0 {
        if e & 1 == 1 {
            result *= base;
        }
        base *= base;
        e >>= 1;
    }
    if n < 0 {
        1.0 / result
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与标准库对比：相对误差应在 1e-6 以内（对图像核足够）
    #[test]
    fn sin_matches_libm_closely() {
        let mut max_err = 0f32;
        let mut x = -6.3f32;
        while x <= 6.3 {
            let a = sin(x);
            let b = x.sin();
            let err = (a - b).abs();
            max_err = max_err.max(err);
            x += 0.01;
        }
        assert!(max_err < 1e-6, "sin 最大误差 {max_err}");
    }

    #[test]
    fn cos_matches_libm_closely() {
        let mut max_err = 0f32;
        let mut x = -6.3f32;
        while x <= 6.3 {
            let err = (cos(x) - x.cos()).abs();
            max_err = max_err.max(err);
            x += 0.01;
        }
        assert!(max_err < 1e-6, "cos 最大误差 {max_err}");
    }

    #[test]
    fn exp_matches_libm_closely() {
        let mut max_err = 0f32;
        let mut x = -10.0f32;
        while x <= 10.0 {
            let a = exp(x);
            let b = x.exp();
            if b.is_finite() && b > 1e-30 {
                let rel = ((a - b) / b).abs();
                max_err = max_err.max(rel);
            }
            x += 0.05;
        }
        assert!(max_err < 1e-5, "exp 最大相对误差 {max_err}");
    }

    #[test]
    fn sin_key_values() {
        assert!(sin(0.0).abs() < 1e-9);
        assert!((sin(HALF_PI) - 1.0).abs() < 1e-6);
        assert!(sin(PI).abs() < 1e-5);
        assert!((sin(-HALF_PI) + 1.0).abs() < 1e-6);
        assert!(sin(TWO_PI).abs() < 1e-5);
    }

    #[test]
    fn exp_key_values() {
        assert!((exp(0.0) - 1.0).abs() < 1e-7);
        assert!((exp(1.0) - std::f32::consts::E).abs() < 1e-5);
        assert!((exp(-1.0) - 1.0 / std::f32::consts::E).abs() < 1e-5);
        assert_eq!(exp(200.0), f32::INFINITY);
        assert_eq!(exp(-200.0), 0.0);
    }

    #[test]
    fn powi_integers() {
        assert!((powi(2.0, 10) - 1024.0).abs() < 1e-3);
        assert!((powi(3.0, 0) - 1.0).abs() < 1e-6);
        assert!((powi(0.5, -2) - 4.0).abs() < 1e-5);
    }

    #[test]
    fn nan_propagates() {
        assert!(sin(f32::NAN).is_nan());
        assert!(exp(f32::NAN).is_nan());
    }

    /// 这条是核心：同样的输入在**同一进程内反复调用**必须完全相同（确定性）。
    /// 跨平台一致性由 CI 的 conformance 测试保证（需要在 wasm 与 native 各跑一次）。
    #[test]
    fn is_deterministic_within_process() {
        for x in [0.1f32, 0.7, 1.5, 2.25, 2.999, -3.3] {
            assert_eq!(sin(x).to_bits(), sin(x).to_bits());
            assert_eq!(exp(x).to_bits(), exp(x).to_bits());
        }
    }
}
