//! 图片模块：参数、解码、变换、编码、流水线。

pub mod colorops;
pub mod decode;
pub mod encode;
pub mod geometry;
pub mod params;
pub mod pipeline;
pub mod resize;

#[cfg(feature = "exif")]
pub mod exif;

pub use decode::{decode_rgba, probe, sniff_format, RasterImage};
pub use encode::encode;
pub use params::{
    Adjust, Crop, EncodeOptions, Filter, Flip, ImageMeta, ImageParams, ImageResult, Resize,
    ResizeMode, Rgba8, Rotation,
};
pub use pipeline::{
    compress, output_name, probe_image, process_image, savings_ratio, savings_text, Ctx,
};
pub use resize::{resize, ResizeCtx};
