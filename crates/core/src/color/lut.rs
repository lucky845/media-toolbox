//! 通用 LUT：单通道 256 项映射与三通道曲线。

/// 单通道 8 位 LUT。
#[derive(Clone)]
pub struct Lut8([u8; 256]);

impl Lut8 {
    pub fn identity() -> Self {
        let mut t = [0u8; 256];
        for (i, v) in t.iter_mut().enumerate() {
            *v = i as u8;
        }
        Lut8(t)
    }

    pub fn from_fn(f: impl Fn(u8) -> u8) -> Self {
        let mut t = [0u8; 256];
        for (i, v) in t.iter_mut().enumerate() {
            *v = f(i as u8);
        }
        Lut8(t)
    }

    #[inline]
    pub fn apply(&self, v: u8) -> u8 {
        self.0[v as usize]
    }

    pub fn table(&self) -> &[u8; 256] {
        &self.0
    }

    /// 是否与恒等映射相同（用于跳过无意义的算子）。
    pub fn is_identity(&self) -> bool {
        self.0.iter().enumerate().all(|(i, &v)| v as usize == i)
    }
}

/// 按 LUT 就地处理 RGBA 缓冲的 RGB 三个通道（alpha 不动）。
pub fn apply_rgb_in_place(data: &mut [u8], lut: &Lut8) {
    for p in data.chunks_exact_mut(4) {
        p[0] = lut.apply(p[0]);
        p[1] = lut.apply(p[1]);
        p[2] = lut.apply(p[2]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_identity() {
        let l = Lut8::identity();
        assert!(l.is_identity());
        for v in [0u8, 1, 127, 255] {
            assert_eq!(l.apply(v), v);
        }
    }

    #[test]
    fn invert_is_not_identity() {
        let l = Lut8::from_fn(|v| 255 - v);
        assert!(!l.is_identity());
        assert_eq!(l.apply(0), 255);
    }

    #[test]
    fn apply_rgb_skips_alpha() {
        let mut data = vec![10, 20, 30, 40];
        let l = Lut8::from_fn(|v| v.wrapping_mul(2));
        apply_rgb_in_place(&mut data, &l);
        assert_eq!(data, vec![20, 40, 60, 40]);
    }
}
