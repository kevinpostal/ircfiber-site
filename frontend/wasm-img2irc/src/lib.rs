use wasm_bindgen::prelude::*;

// --- Color science (mirrors img2irc.ts) ---

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0/2.4) - 0.055 }
}

#[allow(non_snake_case)]
#[wasm_bindgen]
pub fn srgb_to_oklab(r: u8, g: u8, b: u8) -> Vec<f32> {
    let rf = r as f32 / 255.0;
    let gf = g as f32 / 255.0;
    let bf = b as f32 / 255.0;
    let r_lin = srgb_to_linear(rf);
    let g_lin = srgb_to_linear(gf);
    let b_lin = srgb_to_linear(bf);
    let l = 0.4122214708 * r_lin + 0.5363325363 * g_lin + 0.0514459929 * b_lin;
    let m = 0.2119034982 * r_lin + 0.6806995451 * g_lin + 0.1073969566 * b_lin;
    let s = 0.0883024619 * r_lin + 0.2817188376 * g_lin + 0.6299787005 * b_lin;
    let l_ = l.cbrt();
    let m_ = m.cbrt();
    let s_ = s.cbrt();
    let L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    let a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    let b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    vec![L, a, b_]
}

#[allow(non_snake_case)]
#[wasm_bindgen]
pub fn oklab_to_srgb(l: f32, a: f32, b: f32) -> Vec<u8> {
    let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b;
    let l3 = l_ * l_ * l_;
    let m3 = m_ * m_ * m_;
    let s3 = s_ * s_ * s_;
    let r_lin = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    let g_lin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    let b_lin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
    let r = (linear_to_srgb(r_lin).clamp(0.0, 1.0) * 255.0).round() as u8;
    let g = (linear_to_srgb(g_lin).clamp(0.0, 1.0) * 255.0).round() as u8;
    let b = (linear_to_srgb(b_lin).clamp(0.0, 1.0) * 255.0).round() as u8;
    vec![r, g, b]
}

#[allow(non_snake_case)]
#[wasm_bindgen]
pub fn oklab_blend(f_r: u8, f_g: u8, f_b: u8, b_r: u8, b_g: u8, b_b: u8, t: f32) -> Vec<u8> {
    let f = srgb_to_oklab(f_r, f_g, f_b);
    let b = srgb_to_oklab(b_r, b_g, b_b);
    let l = f[0] * t + b[0] * (1.0 - t);
    let a = f[1] * t + b[1] * (1.0 - t);
    let bb = f[2] * t + b[2] * (1.0 - t);
    oklab_to_srgb(l, a, bb)
}

fn color_dist2(r1: u8, g1: u8, b1: u8, r2: u8, g2: u8, b2: u8, mode: &str) -> f32 {
    match mode {
        "oklab" => {
            let a = srgb_to_oklab(r1, g1, b1);
            let b = srgb_to_oklab(r2, g2, b2);
            let dl = a[0]-b[0]; let da = a[1]-b[1]; let db = a[2]-b[2];
            (dl*dl + da*da + db*db) * 85000.0
        },
        "lab" => {
            let dr = r1 as f32 - r2 as f32;
            let dg = g1 as f32 - g2 as f32;
            let db = b1 as f32 - b2 as f32;
            dr*dr + dg*dg + db*db
        },
        _ => {
            let dr = r1 as f32 - r2 as f32;
            let dg = g1 as f32 - g2 as f32;
            let db = b1 as f32 - b2 as f32;
            dr*dr + dg*dg + db*db
        }
    }
}

#[wasm_bindgen]
pub fn nearest_index(r: u8, g: u8, b: u8, palette: &[u32], mode: &str) -> usize {
    let mut best = 0usize;
    let mut best_d = f32::INFINITY;
    for (i, &c) in palette.iter().enumerate() {
        let cr = ((c >> 16) & 255) as u8;
        let cg = ((c >> 8) & 255) as u8;
        let cb = (c & 255) as u8;
        let d = color_dist2(r, g, b, cr, cg, cb, mode);
        if d < best_d { best_d = d; best = i; if d == 0.0 { break; } }
    }
    best
}

#[wasm_bindgen]
pub fn nearest_index_irc(r: u8, g: u8, b: u8, palette: &[u32], irc_palette: &[u32], mode: &str) -> usize {
    let idx = nearest_index(r, g, b, palette, mode);
    if palette.len() <= 99 { return idx.min(98); }
    let c = palette[idx];
    let cr = ((c >> 16) & 255) as u8;
    let cg = ((c >> 8) & 255) as u8;
    let cb = (c & 255) as u8;
    nearest_index(cr, cg, cb, irc_palette, mode).min(98)
}

#[wasm_bindgen]
pub fn bilateral_filter(data: &mut [u8], p_w: usize, p_h: usize, radius: usize, sigma: f32, passes: usize) {
    let sigma2 = 2.0 * sigma * sigma;
    let len = data.len();
    let mut tmp = vec![0u8; len];
    for _ in 0..passes {
        let src = data.to_vec();
        for y in 0..p_h {
            for x in 0..p_w {
                let i = (y * p_w + x) * 4;
                let r0 = src[i] as f32;
                let g0 = src[i+1] as f32;
                let b0 = src[i+2] as f32;
                let mut acc_r = 0.0; let mut acc_g = 0.0; let mut acc_b = 0.0; let mut wsum = 0.0;
                for dy in -(radius as i32)..=(radius as i32) {
                    let yy = y as i32 + dy;
                    if yy < 0 || yy >= p_h as i32 { continue; }
                    for dx in -(radius as i32)..=(radius as i32) {
                        let xx = x as i32 + dx;
                        if xx < 0 || xx >= p_w as i32 { continue; }
                        let j = (yy as usize * p_w + xx as usize) * 4;
                        let r = src[j] as f32; let g = src[j+1] as f32; let b = src[j+2] as f32;
                        let d2 = (r-r0)*(r-r0)+(g-g0)*(g-g0)+(b-b0)*(b-b0);
                        let w = (-d2 / sigma2).exp();
                        acc_r += w * r; acc_g += w * g; acc_b += w * b; wsum += w;
                    }
                }
                tmp[i] = (acc_r / wsum).round().clamp(0.0, 255.0) as u8;
                tmp[i+1] = (acc_g / wsum).round().clamp(0.0, 255.0) as u8;
                tmp[i+2] = (acc_b / wsum).round().clamp(0.0, 255.0) as u8;
                tmp[i+3] = src[i+3];
            }
        }
        data.copy_from_slice(&tmp);
    }
}

#[allow(non_snake_case)]
#[wasm_bindgen]
pub fn best_glyph_for_state(
    r1: u8, g1: u8, b1: u8, r2: u8, g2: u8, b2: u8,
    f_r: u8, f_g: u8, f_b: u8, b_r: u8, b_g: u8, b_b: u8,
    mode: &str, w: f32
) -> usize {
    const GLYPHS: [(f32,f32,f32); 13] = [
        (0.0, 0.0, 1.0),
        (0.122, 0.120, 1.0),
        (0.247, 0.261, 1.0),
        (0.294, 0.253, 1.0),
        (0.183, 0.010, 1.0),
        (0.149, 0.321, 1.0),
        (0.245, 0.107, 1.0),
        (1.0, 0.0, 3.0),
        (0.0, 1.0, 3.0),
        (0.490, 0.499, 3.0),
        (0.183, 0.181, 3.0),
        (0.796, 0.816, 3.0),
        (1.0, 1.0, 3.0),
    ];
    let mut best_idx = 7usize;
    let mut best_cost = f32::INFINITY;
    for (idx, (ct, cb, bytes)) in GLYPHS.iter().enumerate() {
        let (t_r, t_g, t_b) = if mode == "oklab" {
            let trgb = oklab_blend(f_r, f_g, f_b, b_r, b_g, b_b, *ct);
            (trgb[0], trgb[1], trgb[2])
        } else {
            (((f_r as f32)*ct + (b_r as f32)*(1.0-ct)).round() as u8,
             ((f_g as f32)*ct + (b_g as f32)*(1.0-ct)).round() as u8,
             ((f_b as f32)*ct + (b_b as f32)*(1.0-ct)).round() as u8)
        };
        let (bo_r, bo_g, bo_b) = if mode == "oklab" {
            let brgb = oklab_blend(f_r, f_g, f_b, b_r, b_g, b_b, *cb);
            (brgb[0], brgb[1], brgb[2])
        } else {
            (((f_r as f32)*cb + (b_r as f32)*(1.0-cb)).round() as u8,
             ((f_g as f32)*cb + (b_g as f32)*(1.0-cb)).round() as u8,
             ((f_b as f32)*cb + (b_b as f32)*(1.0-cb)).round() as u8)
        };
        let e = color_dist2(r1,g1,b1,t_r,t_g,t_b,mode) + color_dist2(r2,g2,b2,bo_r,bo_g,bo_b,mode);
        let cost = e + w * bytes;
        if cost < best_cost { best_cost = cost; best_idx = idx; }
    }
    best_idx
}

#[wasm_bindgen]
pub fn viterbi_row(_row: usize) -> bool { true }

#[wasm_bindgen]
pub fn has_simd() -> bool { true }

#[wasm_bindgen]
pub fn alpha_blend(f_r: u8, f_g: u8, f_b: u8, b_r: u8, b_g: u8, b_b: u8, t: f32) -> Vec<u8> {
    oklab_blend(f_r, f_g, f_b, b_r, b_g, b_b, t)
}
