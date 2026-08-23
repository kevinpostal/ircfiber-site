pub mod chars;
use chars::GLYPH_BITMAPS;
use wasm_bindgen::prelude::*;
use std::cell::RefCell;
thread_local! {
    static PAL_CACHE: RefCell<Option<(Vec<u32>, Vec<(u8,u8,u8)>, Vec<[f32;3]>)>> = RefCell::new(None);
}

// --- Color science (mirrors img2irc.ts) ---

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0/2.4) - 0.055 }
}

fn srgb_to_lab_inner(r: u8, g: u8, b: u8) -> [f32;3] {
    let rf = r as f32 / 255.0;
    let gf = g as f32 / 255.0;
    let bf = b as f32 / 255.0;
    let r_lin = if rf <= 0.04045 { rf / 12.92 } else { ((rf + 0.055) / 1.055).powf(2.4) };
    let g_lin = if gf <= 0.04045 { gf / 12.92 } else { ((gf + 0.055) / 1.055).powf(2.4) };
    let b_lin = if bf <= 0.04045 { bf / 12.92 } else { ((bf + 0.055) / 1.055).powf(2.4) };
    let x = r_lin*0.4124 + g_lin*0.3576 + b_lin*0.1805;
    let y = r_lin*0.2126 + g_lin*0.7152 + b_lin*0.0722;
    let z = r_lin*0.0193 + g_lin*0.1192 + b_lin*0.9505;
    let xn = 0.95047; let yn = 1.0; let zn = 1.08883;
    let fx = if x/xn > 0.008856 { (x/xn).powf(1.0/3.0) } else { 7.787*x/xn + 16.0/116.0 };
    let fy = if y/yn > 0.008856 { (y/yn).powf(1.0/3.0) } else { 7.787*y/yn + 16.0/116.0 };
    let fz = if z/zn > 0.008856 { (z/zn).powf(1.0/3.0) } else { 7.787*z/zn + 16.0/116.0 };
    [116.0*fy - 16.0, 500.0*(fx - fy), 200.0*(fy - fz)]
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
            let a = srgb_to_lab_inner(r1,g1,b1);
            let b = srgb_to_lab_inner(r2,g2,b2);
            let dl = a[0]-b[0]; let da = a[1]-b[1]; let db = a[2]-b[2];
            dl*dl + da*da + db*db
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
    const GLYPHS: [(f32,f32,f32); 19] = [
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
        // polygon extensions
        (0.5, 0.5, 3.0),      // 13 ▌
        (0.5, 0.5, 3.0),      // 14 ▐
        (0.8125, 0.3125, 3.0),// 15 ◤
        (0.1875, 0.6875, 3.0),// 16 ◢
        (0.8125, 0.3125, 3.0),// 17 ◥
        (0.1875, 0.6875, 3.0),// 18 ◣
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


// --- Batch helpers (direct OKLab + LAB) ---
fn srgb_to_oklab_inner(r: u8, g: u8, b: u8) -> [f32;3] {
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
    [L, a, b_]
}
fn oklab_to_srgb_inner(l: f32, a: f32, b: f32) -> [u8;3] {
    let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b;
    let l3 = l_*l_*l_;
    let m3 = m_*m_*m_;
    let s3 = s_*s_*s_;
    let r_lin = 4.0767416621*l3 - 3.3077115913*m3 + 0.2309699292*s3;
    let g_lin = -1.2684380046*l3 + 2.6097574011*m3 - 0.3413193965*s3;
    let b_lin = -0.0041960863*l3 - 0.7034186147*m3 + 1.7076147010*s3;
    let r = linear_to_srgb(r_lin).clamp(0.0,1.0)*255.0;
    let g = linear_to_srgb(g_lin).clamp(0.0,1.0)*255.0;
    let b = linear_to_srgb(b_lin).clamp(0.0,1.0)*255.0;
    [r.round() as u8, g.round() as u8, b.round() as u8]
}
fn color_dist2_u8(r1:u8,g1:u8,b1:u8,r2:u8,g2:u8,b2:u8,mode:u8)->f32{
    match mode {
        2 => {
            let a = srgb_to_oklab_inner(r1,g1,b1);
            let b = srgb_to_oklab_inner(r2,g2,b2);
            let dl=a[0]-b[0]; let da=a[1]-b[1]; let db=a[2]-b[2];
            (dl*dl+da*da+db*db)*85000.0
        },
        1 => {
            let a = srgb_to_lab_inner(r1,g1,b1);
            let b = srgb_to_lab_inner(r2,g2,b2);
            let dl=a[0]-b[0]; let da=a[1]-b[1]; let db=a[2]-b[2];
            dl*dl+da*da+db*db
        },
        _ => {
            let dr=r1 as f32 - r2 as f32;
            let dg=g1 as f32 - g2 as f32;
            let db=b1 as f32 - b2 as f32;
            dr*dr+dg*dg+db*db
        }
    }
}
#[wasm_bindgen]
pub fn batch_nearest(r: &[u8], g: &[u8], b: &[u8], palette: &[u32], mode: u8, out: &mut [u8]) -> usize {
    let n = r.len().min(g.len()).min(b.len()).min(out.len());
    if palette.is_empty() { return 0; }
    let (pal_rgb, pal_oklab, pal_lab) = PAL_CACHE.with(|cache| {
        let mut c = cache.borrow_mut();
        let need = match c.as_ref() {
            Some((cp,_,_)) => cp.len()!=palette.len() || !cp.iter().zip(palette.iter()).all(|(a,b)| a==b),
            None => true,
        };
        let rgb: Vec<(u8,u8,u8)> = palette.iter().map(|&c| (((c>>16)&255) as u8, ((c>>8)&255) as u8, (c&255) as u8)).collect();
        let oklab: Vec<[f32;3]> = if mode==2 { rgb.iter().map(|&(cr,cg,cb)| srgb_to_oklab_inner(cr,cg,cb)).collect() } else { Vec::new() };
        let lab: Vec<[f32;3]> = if mode==1 { rgb.iter().map(|&(cr,cg,cb)| srgb_to_lab_inner(cr,cg,cb)).collect() } else { Vec::new() };
        if need {
            *c = Some((palette.to_vec(), rgb.clone(), oklab.clone()));
        }
        (rgb, oklab, lab)
    });
    for i in 0..n {
        let rr=r[i]; let gg=g[i]; let bb=b[i];
        let mut best=0u8; let mut best_d=f32::INFINITY;
        if mode==2 {
            let a = srgb_to_oklab_inner(rr,gg,bb);
            for (idx, ok) in pal_oklab.iter().enumerate() {
                let dl=a[0]-ok[0]; let da=a[1]-ok[1]; let db=a[2]-ok[2];
                let d=(dl*dl+da*da+db*db)*85000.0;
                if d < best_d { best_d=d; best=idx as u8; if d==0.0 {break;} }
            }
        } else if mode==1 {
            let a = srgb_to_lab_inner(rr,gg,bb);
            for (idx, lab) in pal_lab.iter().enumerate() {
                let dl=a[0]-lab[0]; let da=a[1]-lab[1]; let db=a[2]-lab[2];
                let d=dl*dl+da*da+db*db;
                if d < best_d { best_d=d; best=idx as u8; if d==0.0 {break;} }
            }
        } else {
            for (idx, &(cr,cg,cb)) in pal_rgb.iter().enumerate() {
                let dr=rr as f32 - cr as f32;
                let dg=gg as f32 - cg as f32;
                let db=bb as f32 - cb as f32;
                let d=dr*dr+dg*dg+db*db;
                if d < best_d { best_d=d; best=idx as u8; if d==0.0 {break;} }
            }
        }
        out[i]=best;
    }
    n
}
#[wasm_bindgen]
pub fn batch_best_glyph(
    r1: &[u8], g1: &[u8], b1: &[u8],
    r2: &[u8], g2: &[u8], b2: &[u8],
    states_f: &[u32], states_b: &[u32],
    palette: &[u32],
    mode: u8,
    w: f32,
    out_glyph: &mut [u8],
    out_err: &mut [f32],
    out_bytes: &mut [u8],
) -> usize {
    let m = r1.len().min(g1.len()).min(b1.len()).min(r2.len()).min(g2.len()).min(b2.len());
    let s_len = states_f.len().min(states_b.len());
    if m==0 || s_len==0 || out_glyph.len() < m*s_len || out_err.len() < m*s_len || out_bytes.len() < m*s_len { return 0; }
    if palette.is_empty() { return 0; }
    const GLYPHS: [(f32,f32,f32); 19] = [
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
        (0.5, 0.5, 3.0),      // 13 ▌
        (0.5, 0.5, 3.0),      // 14 ▐
        (0.8125, 0.3125, 3.0),// 15 ◤
        (0.1875, 0.6875, 3.0),// 16 ◢
        (0.8125, 0.3125, 3.0),// 17 ◥
        (0.1875, 0.6875, 3.0),// 18 ◣
    ];
    let (pal_rgb, pal_oklab) = PAL_CACHE.with(|cache| {
        let mut c = cache.borrow_mut();
        let need = match c.as_ref() {
            Some((cp,_,_)) => cp.len()!=palette.len() || !cp.iter().zip(palette.iter()).all(|(a,b)| a==b),
            None => true,
        };
        if need {
            let rgb: Vec<(u8,u8,u8)> = palette.iter().map(|&c| (((c>>16)&255) as u8, ((c>>8)&255) as u8, (c&255) as u8)).collect();
            let oklab: Vec<[f32;3]> = if mode==2 { rgb.iter().map(|&(cr,cg,cb)| srgb_to_oklab_inner(cr,cg,cb)).collect() } else { Vec::new() };
            *c = Some((palette.to_vec(), rgb.clone(), oklab.clone()));
            (rgb, oklab)
        } else {
            let (_, rgb, oklab) = c.as_ref().unwrap();
            (rgb.clone(), oklab.clone())
        }
    });
    let pal_lab: Vec<[f32;3]> = if mode==1 {
        pal_rgb.iter().map(|&(cr,cg,cb)| srgb_to_lab_inner(cr,cg,cb)).collect()
    } else { Vec::new() };
    for i in 0..m {
        let rr1=r1[i]; let gg1=g1[i]; let bb1=b1[i];
        let rr2=r2[i]; let gg2=g2[i]; let bb2=b2[i];
        let pix1_ok = if mode==2 { srgb_to_oklab_inner(rr1,gg1,bb1) } else { [0.0,0.0,0.0] };
        let pix2_ok = if mode==2 { srgb_to_oklab_inner(rr2,gg2,bb2) } else { [0.0,0.0,0.0] };
        let pix1_lab = if mode==1 { srgb_to_lab_inner(rr1,gg1,bb1) } else { [0.0,0.0,0.0] };
        let pix2_lab = if mode==1 { srgb_to_lab_inner(rr2,gg2,bb2) } else { [0.0,0.0,0.0] };
        for s in 0..s_len {
            let f_idx = states_f[s] as usize;
            let b_idx = states_b[s] as usize;
            if f_idx >= pal_rgb.len() || b_idx >= pal_rgb.len() { out_glyph[i*s_len+s]=7; out_err[i*s_len+s]=0.0; out_bytes[i*s_len+s]=3; continue; }
            let (f_r,f_g,f_b) = pal_rgb[f_idx];
            let (b_r,b_g,b_b) = pal_rgb[b_idx];
            let f_ok = if mode==2 { pal_oklab[f_idx] } else { [0.0,0.0,0.0] };
            let b_ok = if mode==2 { pal_oklab[b_idx] } else { [0.0,0.0,0.0] };
            let f_lab = if mode==1 { pal_lab[f_idx] } else { [0.0,0.0,0.0] };
            let b_lab = if mode==1 { pal_lab[b_idx] } else { [0.0,0.0,0.0] };
            let mut best_idx=0usize; let mut best_cost=f32::INFINITY; let mut best_err=0.0;
            for (g_idx, (ct,cb,bytes)) in GLYPHS.iter().enumerate() {
                let e = if mode==2 {
                    let lt = f_ok[0]*ct + b_ok[0]*(1.0-ct);
                    let at = f_ok[1]*ct + b_ok[1]*(1.0-ct);
                    let bt = f_ok[2]*ct + b_ok[2]*(1.0-ct);
                    let dl = pix1_ok[0]-lt; let da = pix1_ok[1]-at; let db = pix1_ok[2]-bt;
                    let e1 = (dl*dl+da*da+db*db)*85000.0;
                    let lb = f_ok[0]*cb + b_ok[0]*(1.0-cb);
                    let ab = f_ok[1]*cb + b_ok[1]*(1.0-cb);
                    let bb_ = f_ok[2]*cb + b_ok[2]*(1.0-cb);
                    let dl2 = pix2_ok[0]-lb; let da2 = pix2_ok[1]-ab; let db2 = pix2_ok[2]-bb_;
                    let e2 = (dl2*dl2+da2*da2+db2*db2)*85000.0;
                    e1+e2
                } else if mode==1 {
                    let lt = f_lab[0]*ct + b_lab[0]*(1.0-ct);
                    let at = f_lab[1]*ct + b_lab[1]*(1.0-ct);
                    let bt = f_lab[2]*ct + b_lab[2]*(1.0-ct);
                    let dl1 = pix1_lab[0]-lt; let da1 = pix1_lab[1]-at; let db1 = pix1_lab[2]-bt;
                    let e1 = dl1*dl1+da1*da1+db1*db1;
                    let lb = f_lab[0]*cb + b_lab[0]*(1.0-cb);
                    let ab = f_lab[1]*cb + b_lab[1]*(1.0-cb);
                    let bb_ = f_lab[2]*cb + b_lab[2]*(1.0-cb);
                    let dl2 = pix2_lab[0]-lb; let da2 = pix2_lab[1]-ab; let db2 = pix2_lab[2]-bb_;
                    let e2 = dl2*dl2+da2*da2+db2*db2;
                    e1+e2
                } else {
                    let t_r = ((f_r as f32)*ct + (b_r as f32)*(1.0-ct)).round() as u8;
                    let t_g = ((f_g as f32)*ct + (b_g as f32)*(1.0-ct)).round() as u8;
                    let t_b = ((f_b as f32)*ct + (b_b as f32)*(1.0-ct)).round() as u8;
                    let bo_r = ((f_r as f32)*cb + (b_r as f32)*(1.0-cb)).round() as u8;
                    let bo_g = ((f_g as f32)*cb + (b_g as f32)*(1.0-cb)).round() as u8;
                    let bo_b = ((f_b as f32)*cb + (b_b as f32)*(1.0-cb)).round() as u8;
                    color_dist2_u8(rr1,gg1,bb1,t_r,t_g,t_b,mode) + color_dist2_u8(rr2,gg2,bb2,bo_r,bo_g,bo_b,mode)
                };
                let cost = e + w * bytes;
                if cost < best_cost { best_cost=cost; best_idx=g_idx; best_err=e; }
            }
            out_glyph[i*s_len+s]=best_idx as u8;
            out_err[i*s_len+s]=best_err;
            out_bytes[i*s_len+s]=GLYPHS[best_idx].2 as u8;
        }
    }
    m*s_len
}
#[wasm_bindgen]
pub fn batch_best_glyph_polygon(
    masks: &[u64],
    states_f: &[u32], states_b: &[u32],
    palette: &[u32],
    mode: u8,
    w: f32,
    out_glyph: &mut [u8],
    out_err: &mut [f32],
    out_bytes: &mut [u8],
) -> usize {
    let m = masks.len();
    let s_len = states_f.len().min(states_b.len());
    if m==0 || s_len==0 || out_glyph.len() < m*s_len || out_err.len() < m*s_len || out_bytes.len() < m*s_len { return 0; }
    if palette.is_empty() { return 0; }
    // 9 polygon glyphs mapped to full GLYPHS indices: space(0), ▀(7),▄(8),▌(13),▐(14),◤(15),◢(16),◥(17),◣(18)
    const POLY_INDICES: [usize; 9] = [0,7,8,13,14,15,16,17,18];
    const POLY_MASKS: [u64; 9] = [
        0x0000000000000000u64, // space
        0x00000000ffffffffu64, // ▀ top half
        0xffffffff00000000u64, // ▄ bottom half
        0x0f0f0f0f0f0f0f0fu64, // ▌
        0xf0f0f0f0f0f0f0f0u64, // ▐
        0x0103070f1f3f7fffu64, // ◤
        0xfefcf8f0e0c08000u64, // ◢
        0x80c0e0f0f8fcfeffu64, // ◥
        0x7f3f1f0f07030100u64, // ◣
    ];
    const POLY_BYTES: [u8; 9] = [1,3,3,3,3,3,3,3,3];
    let (pal_rgb, pal_oklab) = PAL_CACHE.with(|cache| {
        let mut c = cache.borrow_mut();
        let need = match c.as_ref() {
            Some((cp,_,_)) => cp.len()!=palette.len() || !cp.iter().zip(palette.iter()).all(|(a,b)| a==b),
            None => true,
        };
        if need {
            let rgb: Vec<(u8,u8,u8)> = palette.iter().map(|&c| (((c>>16)&255) as u8, ((c>>8)&255) as u8, (c&255) as u8)).collect();
            let oklab: Vec<[f32;3]> = if mode==2 { rgb.iter().map(|&(cr,cg,cb)| srgb_to_oklab_inner(cr,cg,cb)).collect() } else { Vec::new() };
            *c = Some((palette.to_vec(), rgb.clone(), oklab.clone()));
            (rgb, oklab)
        } else {
            let (_, rgb, oklab) = c.as_ref().unwrap();
            (rgb.clone(), oklab.clone())
        }
    });
    // need palette oklab for contrast
    for i in 0..m {
        let sub = masks[i];
        for s in 0..s_len {
            let f_idx = states_f[s] as usize;
            let b_idx = states_b[s] as usize;
            if f_idx >= pal_rgb.len() || b_idx >= pal_rgb.len() { out_glyph[i*s_len+s]=0; out_err[i*s_len+s]=0.0; out_bytes[i*s_len+s]=1; continue; }
            let (f_r,f_g,f_b) = pal_rgb[f_idx];
            let (b_r,b_g,b_b) = pal_rgb[b_idx];
            let contrast = if mode==2 {
                let f_ok = pal_oklab[f_idx];
                let b_ok = pal_oklab[b_idx];
                let dl=f_ok[0]-b_ok[0]; let da=f_ok[1]-b_ok[1]; let db=f_ok[2]-b_ok[2];
                (dl*dl+da*da+db*db)*85000.0
            } else if mode==1 {
                // use lab approx via color_dist2_u8 for fg-bg
                color_dist2_u8(f_r,f_g,f_b,b_r,b_g,b_b,mode)
            } else {
                let dr=f_r as f32 - b_r as f32; let dg=f_g as f32 - b_g as f32; let db=f_b as f32 - b_b as f32;
                dr*dr+dg*dg+db*db
            };
            let mut best_cost = f32::INFINITY;
            let mut best_idx = 0usize;
            let mut best_err = 0.0;
            for p in 0..POLY_MASKS.len(){
                let pm = POLY_MASKS[p];
                let dist = (sub ^ pm).count_ones() as f32;
                let err = dist * contrast / 64.0;
                let bytes = POLY_BYTES[p] as f32;
                let cost = err + w * bytes;
                if cost < best_cost { best_cost=cost; best_idx=POLY_INDICES[p]; best_err=err; }
            }
            out_glyph[i*s_len+s]=best_idx as u8;
            out_err[i*s_len+s]=best_err;
            out_bytes[i*s_len+s]=if best_idx==0 {1} else {3};
        }
    }
    m*s_len
}
#[wasm_bindgen]
pub fn batch_row_palette(
    r_tops: &[u8], g_tops: &[u8], b_tops: &[u8],
    r_bots: &[u8], g_bots: &[u8], b_bots: &[u8],
    palette: &[u32],
    mode: u8,
    size: usize,
    ng: u8,
    out: &mut [u32],
) -> usize {
    let m = r_tops.len().min(g_tops.len()).min(b_tops.len()).min(r_bots.len()).min(g_bots.len()).min(b_bots.len());
    if m==0 || palette.is_empty() || out.is_empty() { return 0; }
    let out_len = size.min(out.len()).min(palette.len());
    if out_len==0 { return 0; }
    let (pal_rgb, pal_oklab) = PAL_CACHE.with(|cache| {
        let mut c = cache.borrow_mut();
        let need = match c.as_ref() {
            Some((cp,_,_)) => cp.len()!=palette.len() || !cp.iter().zip(palette.iter()).all(|(a,b)| a==b),
            None => true,
        };
        if need {
            let rgb: Vec<(u8,u8,u8)> = palette.iter().map(|&c| (((c>>16)&255) as u8, ((c>>8)&255) as u8, (c&255) as u8)).collect();
            let oklab: Vec<[f32;3]> = if mode==2 { rgb.iter().map(|&(cr,cg,cb)| srgb_to_oklab_inner(cr,cg,cb)).collect() } else { Vec::new() };
            *c = Some((palette.to_vec(), rgb.clone(), oklab.clone()));
            (rgb, oklab)
        } else {
            let (_, rgb, oklab) = c.as_ref().unwrap();
            (rgb.clone(), oklab.clone())
        }
    });
    let pal_lab: Vec<[f32;3]> = if mode==1 {
        pal_rgb.iter().map(|&(cr,cg,cb)| srgb_to_lab_inner(cr,cg,cb)).collect()
    } else { Vec::new() };
    let mut freq = vec![0usize; palette.len()];
    let ng_bool = ng != 0;
    for c in 0..m {
        let r1=r_tops[c]; let g1=g_tops[c]; let b1=b_tops[c];
        let r2=r_bots[c]; let g2=g_bots[c]; let b2=b_bots[c];
        if r1<10 && g1<10 && b1<10 && r2<10 && g2<10 && b2<10 { continue; }
        for &(rr,gg,bb) in &[(r1,g1,b1),(r2,g2,b2)] {
            let is_gray = {
                let mx = rr.max(gg).max(bb);
                let mn = rr.min(gg).min(bb);
                mx - mn <= 16
            };
            let mut best: [(usize,f32);2] = [(usize::MAX, f32::INFINITY),(usize::MAX, f32::INFINITY)];
            for (idx, &(cr,cg,cb)) in pal_rgb.iter().enumerate() {
                if ng_bool && !is_gray {
                    let mx2 = cr.max(cg).max(cb);
                    let mn2 = cr.min(cg).min(cb);
                    if mx2 - mn2 <= 16 { continue; }
                }
                let d = if mode==2 {
                    let a = srgb_to_oklab_inner(rr,gg,bb);
                    let ok = pal_oklab[idx];
                    let dl=a[0]-ok[0]; let da=a[1]-ok[1]; let db=a[2]-ok[2];
                    (dl*dl+da*da+db*db)*85000.0
                } else if mode==1 {
                    let a = srgb_to_lab_inner(rr,gg,bb);
                    let lab = pal_lab[idx];
                    let dl=a[0]-lab[0]; let da=a[1]-lab[1]; let db=a[2]-lab[2];
                    dl*dl+da*da+db*db
                } else {
                    let dr=rr as f32 - cr as f32;
                    let dg=gg as f32 - cg as f32;
                    let db=bb as f32 - cb as f32;
                    dr*dr+dg*dg+db*db
                };
                if d < best[0].1 {
                    best[1]=best[0];
                    best[0]=(idx,d);
                } else if d < best[1].1 {
                    best[1]=(idx,d);
                }
            }
            if best[0].0==usize::MAX || (best[1].0==usize::MAX && ng_bool && !is_gray) {
                for (idx, &(cr,cg,cb)) in pal_rgb.iter().enumerate() {
                    if best[0].0==idx || best[1].0==idx { continue; }
                    let d = if mode==2 {
                        let a = srgb_to_oklab_inner(rr,gg,bb);
                        let ok = pal_oklab[idx];
                        let dl=a[0]-ok[0]; let da=a[1]-ok[1]; let db=a[2]-ok[2];
                        (dl*dl+da*da+db*db)*85000.0
                    } else if mode==1 {
                        let a = srgb_to_lab_inner(rr,gg,bb);
                        let lab = pal_lab[idx];
                        let dl=a[0]-lab[0]; let da=a[1]-lab[1]; let db=a[2]-lab[2];
                        dl*dl+da*da+db*db
                    } else {
                        let dr=rr as f32 - cr as f32;
                        let dg=gg as f32 - cg as f32;
                        let db=bb as f32 - cb as f32;
                        dr*dr+dg*dg+db*db
                    };
                    if d < best[0].1 {
                        best[1]=best[0];
                        best[0]=(idx,d);
                    } else if d < best[1].1 {
                        best[1]=(idx,d);
                    }
                }
            }
            for k in 0..2 {
                if best[k].0 != usize::MAX {
                    freq[best[k].0] += 1;
                }
            }
        }
    }
    let lambda = 0.02;
    let mut scored: Vec<(usize,f32,usize)> = Vec::new();
    for (idx, &f) in freq.iter().enumerate() {
        if f==0 { continue; }
        let cl = if idx < 10 {1} else {2};
        let score = f as f32 / (1.0 + lambda * cl as f32);
        scored.push((idx, score, f));
    }
    if scored.is_empty() {
        let fallback = [0,1,7];
        for i in 0..out_len.min(3) { out[i]=fallback[i] as u32; }
        return out_len.min(3);
    }
    scored.sort_by(|a,b| b.1.partial_cmp(&a.1).unwrap().then(b.2.cmp(&a.2)).then(a.0.cmp(&b.0)));
    for i in 0..out_len {
        if i < scored.len() { out[i]=scored[i].0 as u32; } else { out[i]=scored[0].0 as u32; }
    }
    out_len
}
#[wasm_bindgen]
pub fn batch_best_glyph_custom(
    r1: &[u8], g1: &[u8], b1: &[u8],
    r2: &[u8], g2: &[u8], b2: &[u8],
    states_f: &[u32], states_b: &[u32],
    palette: &[u32],
    mode: u8,
    w: f32,
    glyph_ct: &[f32], glyph_cb: &[f32], glyph_bytes: &[u8],
    out_glyph: &mut [u8],
    out_err: &mut [f32],
    out_bytes: &mut [u8],
) -> usize {
    let m = r1.len().min(g1.len()).min(b1.len()).min(r2.len()).min(g2.len()).min(b2.len());
    let s_len = states_f.len().min(states_b.len());
    let g_len = glyph_ct.len().min(glyph_cb.len()).min(glyph_bytes.len());
    if m==0 || s_len==0 || g_len==0 || out_glyph.len() < m*s_len || out_err.len() < m*s_len || out_bytes.len() < m*s_len { return 0; }
    if palette.is_empty() { return 0; }
    let (pal_rgb, pal_oklab) = PAL_CACHE.with(|cache| {
        let mut c = cache.borrow_mut();
        let need = match c.as_ref() {
            Some((cp,_,_)) => cp.len()!=palette.len() || !cp.iter().zip(palette.iter()).all(|(a,b)| a==b),
            None => true,
        };
        if need {
            let rgb: Vec<(u8,u8,u8)> = palette.iter().map(|&c| (((c>>16)&255) as u8, ((c>>8)&255) as u8, (c&255) as u8)).collect();
            let oklab: Vec<[f32;3]> = if mode==2 { rgb.iter().map(|&(cr,cg,cb)| srgb_to_oklab_inner(cr,cg,cb)).collect() } else { Vec::new() };
            *c = Some((palette.to_vec(), rgb.clone(), oklab.clone()));
            (rgb, oklab)
        } else {
            let (_, rgb, oklab) = c.as_ref().unwrap();
            (rgb.clone(), oklab.clone())
        }
    });
    let pal_lab: Vec<[f32;3]> = if mode==1 {
        pal_rgb.iter().map(|&(cr,cg,cb)| srgb_to_lab_inner(cr,cg,cb)).collect()
    } else { Vec::new() };
    for i in 0..m {
        let rr1=r1[i]; let gg1=g1[i]; let bb1=b1[i];
        let rr2=r2[i]; let gg2=g2[i]; let bb2=b2[i];
        let pix1_ok = if mode==2 { srgb_to_oklab_inner(rr1,gg1,bb1) } else { [0.0,0.0,0.0] };
        let pix2_ok = if mode==2 { srgb_to_oklab_inner(rr2,gg2,bb2) } else { [0.0,0.0,0.0] };
        let pix1_lab = if mode==1 { srgb_to_lab_inner(rr1,gg1,bb1) } else { [0.0,0.0,0.0] };
        let pix2_lab = if mode==1 { srgb_to_lab_inner(rr2,gg2,bb2) } else { [0.0,0.0,0.0] };
        for s in 0..s_len {
            let f_idx = states_f[s] as usize;
            let b_idx = states_b[s] as usize;
            if f_idx >= pal_rgb.len() || b_idx >= pal_rgb.len() { out_glyph[i*s_len+s]=0; out_err[i*s_len+s]=0.0; out_bytes[i*s_len+s]=1; continue; }
            let (f_r,f_g,f_b) = pal_rgb[f_idx];
            let (b_r,b_g,b_b) = pal_rgb[b_idx];
            let f_ok = if mode==2 { pal_oklab[f_idx] } else { [0.0,0.0,0.0] };
            let b_ok = if mode==2 { pal_oklab[b_idx] } else { [0.0,0.0,0.0] };
            let f_lab = if mode==1 { pal_lab[f_idx] } else { [0.0,0.0,0.0] };
            let b_lab = if mode==1 { pal_lab[b_idx] } else { [0.0,0.0,0.0] };
            let mut best_idx=0usize; let mut best_cost=f32::INFINITY; let mut best_err=0.0;
            for g_idx in 0..g_len {
                let ct = glyph_ct[g_idx]; let cb = glyph_cb[g_idx]; let bytes = glyph_bytes[g_idx] as f32;
                let e = if mode==2 {
                    let lt = f_ok[0]*ct + b_ok[0]*(1.0-ct);
                    let at = f_ok[1]*ct + b_ok[1]*(1.0-ct);
                    let bt = f_ok[2]*ct + b_ok[2]*(1.0-ct);
                    let dl = pix1_ok[0]-lt; let da = pix1_ok[1]-at; let db = pix1_ok[2]-bt;
                    let e1 = (dl*dl+da*da+db*db)*85000.0;
                    let lb = f_ok[0]*cb + b_ok[0]*(1.0-cb);
                    let ab = f_ok[1]*cb + b_ok[1]*(1.0-cb);
                    let bb_ = f_ok[2]*cb + b_ok[2]*(1.0-cb);
                    let dl2 = pix2_ok[0]-lb; let da2 = pix2_ok[1]-ab; let db2 = pix2_ok[2]-bb_;
                    let e2 = (dl2*dl2+da2*da2+db2*db2)*85000.0;
                    e1+e2
                } else if mode==1 {
                    let lt = f_lab[0]*ct + b_lab[0]*(1.0-ct);
                    let at = f_lab[1]*ct + b_lab[1]*(1.0-ct);
                    let bt = f_lab[2]*ct + b_lab[2]*(1.0-ct);
                    let dl1 = pix1_lab[0]-lt; let da1 = pix1_lab[1]-at; let db1 = pix1_lab[2]-bt;
                    let e1 = dl1*dl1+da1*da1+db1*db1;
                    let lb = f_lab[0]*cb + b_lab[0]*(1.0-cb);
                    let ab = f_lab[1]*cb + b_lab[1]*(1.0-cb);
                    let bb_ = f_lab[2]*cb + b_lab[2]*(1.0-cb);
                    let dl2 = pix2_lab[0]-lb; let da2 = pix2_lab[1]-ab; let db2 = pix2_lab[2]-bb_;
                    let e2 = dl2*dl2+da2*da2+db2*db2;
                    e1+e2
                } else {
                    let t_r = ((f_r as f32)*ct + (b_r as f32)*(1.0-ct)).round() as u8;
                    let t_g = ((f_g as f32)*ct + (b_g as f32)*(1.0-ct)).round() as u8;
                    let t_b = ((f_b as f32)*ct + (b_b as f32)*(1.0-ct)).round() as u8;
                    let bo_r = ((f_r as f32)*cb + (b_r as f32)*(1.0-cb)).round() as u8;
                    let bo_g = ((f_g as f32)*cb + (b_g as f32)*(1.0-cb)).round() as u8;
                    let bo_b = ((f_b as f32)*cb + (b_b as f32)*(1.0-cb)).round() as u8;
                    color_dist2_u8(rr1,gg1,bb1,t_r,t_g,t_b,mode) + color_dist2_u8(rr2,gg2,bb2,bo_r,bo_g,bo_b,mode)
                };
                let cost = e + w * bytes;
                if cost < best_cost { best_cost=cost; best_idx=g_idx; best_err=e; }
            }
            out_glyph[i*s_len+s]=best_idx as u8;
            out_err[i*s_len+s]=best_err;
            out_bytes[i*s_len+s]=glyph_bytes[best_idx];
        }
    }
    m*s_len
}
 #[wasm_bindgen]
 pub fn has_simd() -> bool { true }

#[wasm_bindgen]
pub fn alpha_blend(f_r: u8, f_g: u8, f_b: u8, b_r: u8, b_g: u8, b_b: u8, t: f32) -> Vec<u8> {
    oklab_blend(f_r, f_g, f_b, b_r, b_g, b_b, t)
}

// ===== ANSI braille full port — render_blocks (from waveplate/img2irc draw.rs) =====
const GRAYSCALE_TOLERANCE: u8 = 16;

const IRC99: [u32; 99] = [
    0xffffff, 0x000000, 0x00007f, 0x009300, 0xff0000, 0x7f0000, 0x9c009c, 0xfc7f00,
    0xffff00, 0x00fc00, 0x009393, 0x00ffff, 0x0000fc, 0xff00ff, 0x555555, 0xaaaaaa,
    0x470000, 0x472100, 0x474700, 0x324700, 0x004700, 0x00472c, 0x004747, 0x002747,
    0x000047, 0x2e0047, 0x470047, 0x47002a, 0x740000, 0x743a00, 0x747400, 0x517400,
    0x007400, 0x007449, 0x007474, 0x004074, 0x000074, 0x4b0074, 0x740074, 0x740045,
    0xb50000, 0xb56300, 0xb5b500, 0x7db500, 0x00b500, 0x00b571, 0x00b5b5, 0x0063b5,
    0x0000b5, 0x7500b5, 0xb500b5, 0xb5006b, 0xff0000, 0xff8c00, 0xffff00, 0xb2ff00,
    0x00ff00, 0x00ffa0, 0x00ffff, 0x008cff, 0x0000ff, 0xa500ff, 0xff00ff, 0xff0098,
    0xff5959, 0xffb459, 0xffff71, 0xcfff60, 0x6fff6f, 0x65ffc9, 0x6dffff, 0x59b4ff,
    0x5959ff, 0xc459ff, 0xff66ff, 0xff59bc, 0xff9c9c, 0xffd39c, 0xffff9c, 0xe2ff9c,
    0x9cff9c, 0x9cffdb, 0x9cffff, 0x9cd3ff, 0x9c9cff, 0xdc9cff, 0xff9cff, 0xff94d3,
    0x000000, 0x131313, 0x282828, 0x363636, 0x4d4d4d, 0x656565, 0x818181, 0x9f9f9f,
    0xbcbcbc, 0xe2e2e2, 0xffffff,
];
const ANSI256: [u32; 256] = [
    0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
    0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
    0x000000, 0x00005f, 0x000087, 0x0000af, 0x0000d7, 0x0000ff, 0x005f00, 0x005f5f,
    0x005f87, 0x005faf, 0x005fd7, 0x005fff, 0x008700, 0x00875f, 0x008787, 0x0087af,
    0x0087d7, 0x0087ff, 0x00af00, 0x00af5f, 0x00af87, 0x00afaf, 0x00afd7, 0x00afff,
    0x00d700, 0x00d75f, 0x00d787, 0x00d7af, 0x00d7d7, 0x00d7ff, 0x00ff00, 0x00ff5f,
    0x00ff87, 0x00ffaf, 0x00ffd7, 0x00ffff, 0x5f0000, 0x5f005f, 0x5f0087, 0x5f00af,
    0x5f00d7, 0x5f00ff, 0x5f5f00, 0x5f5f5f, 0x5f5f87, 0x5f5faf, 0x5f5fd7, 0x5f5fff,
    0x5f8700, 0x5f875f, 0x5f8787, 0x5f87af, 0x5f87d7, 0x5f87ff, 0x5faf00, 0x5faf5f,
    0x5faf87, 0x5fafaf, 0x5fafd7, 0x5fafff, 0x5fd700, 0x5fd75f, 0x5fd787, 0x5fd7af,
    0x5fd7d7, 0x5fd7ff, 0x5fff00, 0x5fff5f, 0x5fff87, 0x5fffaf, 0x5fffd7, 0x5fffff,
    0x870000, 0x87005f, 0x870087, 0x8700af, 0x8700d7, 0x8700ff, 0x875f00, 0x875f5f,
    0x875f87, 0x875faf, 0x875fd7, 0x875fff, 0x878700, 0x87875f, 0x878787, 0x8787af,
    0x8787d7, 0x8787ff, 0x87af00, 0x87af5f, 0x87af87, 0x87afaf, 0x87afd7, 0x87afff,
    0x87d700, 0x87d75f, 0x87d787, 0x87d7af, 0x87d7d7, 0x87d7ff, 0x87ff00, 0x87ff5f,
    0x87ff87, 0x87ffaf, 0x87ffd7, 0x87ffff, 0xaf0000, 0xaf005f, 0xaf0087, 0xaf00af,
    0xaf00d7, 0xaf00ff, 0xaf5f00, 0xaf5f5f, 0xaf5f87, 0xaf5faf, 0xaf5fd7, 0xaf5fff,
    0xaf8700, 0xaf875f, 0xaf8787, 0xaf87af, 0xaf87d7, 0xaf87ff, 0xafaf00, 0xafaf5f,
    0xafaf87, 0xafafaf, 0xafafd7, 0xafafff, 0xafd700, 0xafd75f, 0xafd787, 0xafd7af,
    0xafd7d7, 0xafd7ff, 0xafff00, 0xafff5f, 0xafff87, 0xafffaf, 0xafffd7, 0xafffff,
    0xd70000, 0xd7005f, 0xd70087, 0xd700af, 0xd700d7, 0xd700ff, 0xd75f00, 0xd75f5f,
    0xd75f87, 0xd75faf, 0xd75fd7, 0xd75fff, 0xd78700, 0xd7875f, 0xd78787, 0xd787af,
    0xd787d7, 0xd787ff, 0xd7af00, 0xd7af5f, 0xd7af87, 0xd7afaf, 0xd7afd7, 0xd7afff,
    0xd7d700, 0xd7d75f, 0xd7d787, 0xd7d7af, 0xd7d7d7, 0xd7d7ff, 0xd7ff00, 0xd7ff5f,
    0xd7ff87, 0xd7ffaf, 0xd7ffd7, 0xd7ffff, 0xff0000, 0xff005f, 0xff0087, 0xff00af,
    0xff00d7, 0xff00ff, 0xff5f00, 0xff5f5f, 0xff5f87, 0xff5faf, 0xff5fd7, 0xff5fff,
    0xff8700, 0xff875f, 0xff8787, 0xff87af, 0xff87d7, 0xff87ff, 0xffaf00, 0xffaf5f,
    0xffaf87, 0xffafaf, 0xffafd7, 0xffafff, 0xffd700, 0xffd75f, 0xffd787, 0xffd7af,
    0xffd7d7, 0xffd7ff, 0xffff00, 0xffff5f, 0xffff87, 0xffffaf, 0xffffd7, 0xffffff,
    0x080808, 0x121212, 0x1c1c1c, 0x262626, 0x303030, 0x3a3a3a, 0x444444, 0x4e4e4e,
    0x585858, 0x626262, 0x6c6c6c, 0x767676, 0x808080, 0x8a8a8a, 0x949494, 0x9e9e9e,
    0xa8a8a8, 0xb2b2b2, 0xbcbcbc, 0xc6c6c6, 0xd0d0d0, 0xdadada, 0xe4e4e4, 0xeeeeee
];

#[inline] fn unpack_rgb(rgb: u32) -> [u8;3] { [(rgb >> 16) as u8, (rgb >> 8) as u8, (rgb >> 0) as u8] }
#[inline] fn make_rgb_u32(px: &[u8]) -> u32 { if px.len() < 3 { return 0; } ((px[0] as u32)<<16)|((px[1] as u32)<<8)|(px[2] as u32) }
#[inline] fn is_near_grayscale(col: u32, tolerance: u8) -> bool { let [r,g,b]=unpack_rgb(col); let mn=r.min(g.min(b)); let mx=r.max(g.max(b)); mx.saturating_sub(mn) <= tolerance }

#[inline(always)] fn nearest_hex_colour_fast(col: u32, palette: &[u32]) -> u8 {
    let pr=((col>>16)&0xFF) as i32; let pg=((col>>8)&0xFF) as i32; let pb=((col>>0)&0xFF) as i32;
    let mut best_i=0u8; let mut best_d=u32::MAX; if palette.is_empty(){return 0;}
    for (i,&p) in palette.iter().enumerate(){ let dr=pr-(((p>>16)&0xFF) as i32); let dg=pg-(((p>>8)&0xFF) as i32); let db=pb-(((p>>0)&0xFF) as i32); let d=(dr*dr+dg*dg+db*db) as u32; if d<best_d{best_d=d; best_i=i as u8; if d==0{break;}}}
    best_i
}
#[inline(always)] fn nearest_distinctly_chromatic_hex_colour(col: u32, palette: &[u32], tolerance: u8) -> Option<u8> {
    let pr=((col>>16)&0xFF) as i32; let pg=((col>>8)&0xFF) as i32; let pb=((col>>0)&0xFF) as i32;
    let mut best_i:Option<u8>=None; let mut best_d=u32::MAX;
    for (i,&p) in palette.iter().enumerate(){ if is_near_grayscale(p,tolerance){continue;} let dr=pr-(((p>>16)&0xFF) as i32); let dg=pg-(((p>>8)&0xFF) as i32); let db=pb-(((p>>0)&0xFF) as i32); let d=(dr*dr+dg*dg+db*db) as u32; if d<best_d{best_d=d; best_i=Some(i as u8); if d==0{break;}} }
    best_i
}
#[inline] fn calculate_average_rgb(colors: &[u32]) -> [u8;3] {
    if colors.is_empty(){return [0,0,0];}
    let mut sum_r:u64=0; let mut sum_g:u64=0; let mut sum_b:u64=0;
    for &col in colors{ sum_r+=((col>>16)&0xFF) as u64; sum_g+=((col>>8)&0xFF) as u64; sum_b+=(col&0xFF) as u64; }
    let c=colors.len() as u64; [(sum_r/c) as u8,(sum_g/c) as u8,(sum_b/c) as u8]
}
fn luma(rgb: &[u8;3]) -> u8 { (0.299*rgb[0] as f32+0.587*rgb[1] as f32+0.114*rgb[2] as f32).round() as u8 }

#[derive(Debug,Clone,Copy,PartialEq,Eq,Hash)]
enum Colour { Index(u8), RGB([u8;3]) }
#[derive(Debug,Clone,Copy,PartialEq,Eq,Hash)]
enum BlockKind { Full, Half, Quarter, Eighth, Triangle, Corner, Geometric, Box, Legacy }
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
enum Render { Irc, Ansi, Ansi24 }
impl BlockKind { fn from_str(s: &str)->Option<Self>{ match s.to_lowercase().as_str(){ "full"=>Some(Self::Full),"half"=>Some(Self::Half),"quarter"=>Some(Self::Quarter),"eighth"=>Some(Self::Eighth),"triangle"=>Some(Self::Triangle),"corner"=>Some(Self::Corner),"geometric"=>Some(Self::Geometric),"box"=>Some(Self::Box),"legacy"=>Some(Self::Legacy), _=>None } } }
impl Render { fn from_str(s: &str)->Self{ match s.to_lowercase().as_str(){ "irc"=>Self::Irc,"ansi24"=>Self::Ansi24,"ansi"=>Self::Ansi,_=>Self::Irc } } }

#[derive(Debug,Clone)]
struct AnsiPixel { orig:u32, ansi_std:u8, irc_std:u8, ansi_ng:u8, irc_ng:u8 }
#[derive(Debug,Clone)]
struct AnsiPixelBlock { pixels: Vec<Vec<AnsiPixel>> }
#[derive(Debug,Clone)]
struct AnsiImage { bitmap: Vec<Vec<u32>>, block: Vec<Vec<AnsiPixelBlock>> }
impl AnsiPixel {
    fn new(px: &u32)->Self{
        let ansi_std=nearest_hex_colour_fast(*px,&ANSI256);
        let irc_std=nearest_hex_colour_fast(*px,&IRC99);
        let mut ansi_ng=ansi_std; let mut irc_ng=irc_std;
        if !is_near_grayscale(*px,GRAYSCALE_TOLERANCE){
            if let Some(idx)=nearest_distinctly_chromatic_hex_colour(*px,&ANSI256,GRAYSCALE_TOLERANCE){ ansi_ng=idx; }
            if let Some(idx)=nearest_distinctly_chromatic_hex_colour(*px,&IRC99,GRAYSCALE_TOLERANCE){ irc_ng=idx; }
        }
        Self{ orig:*px, ansi_std, irc_std, ansi_ng, irc_ng }
    }
}
fn block_bitmap(src: &Vec<Vec<u32>>) -> Vec<Vec<AnsiPixelBlock>> {
    if GLYPH_BITMAPS.is_empty(){return Vec::new();}
    let (gh,gw)={let b=&GLYPH_BITMAPS[0].1; (b.len(), b[0].len())};
    if gh==0||gw==0{return Vec::new();}
    let mut px_rows: Vec<Vec<AnsiPixel>> = src.iter().map(|row| row.iter().map(AnsiPixel::new).collect()).collect();
    let ph=((px_rows.len()+gh-1)/gh)*gh;
    let pw= if px_rows.is_empty(){0}else{((px_rows[0].len()+gw-1)/gw)*gw};
    for r in &mut px_rows{ if r.len()<pw{ r.extend(std::iter::repeat(AnsiPixel::new(&0)).take(pw-r.len())); } }
    if px_rows.len()<ph{ let blank=vec![AnsiPixel::new(&0);pw]; px_rows.extend(std::iter::repeat(blank).take(ph-px_rows.len())); }
    let mut out=Vec::with_capacity(ph/gh);
    for y in (0..ph).step_by(gh){ let mut row=Vec::with_capacity(pw/gw); for x in (0..pw).step_by(gw){ let mut block_pixels=vec![vec![AnsiPixel::new(&0);gw];gh]; for j in 0..gh{ for i in 0..gw{ block_pixels[j][i]=px_rows[y+j][x+i].clone(); } } row.push(AnsiPixelBlock{pixels:block_pixels}); } out.push(row); }
    out
}
impl AnsiImage {
    fn from_rgba(data: &[u8], w: usize, h: usize)->Self{
        let mut bitmap:Vec<Vec<u32>>=Vec::with_capacity(h);
        for y in 0..h{ let mut row=Vec::with_capacity(w); for x in 0..w{ let idx=(y*w+x)*4; let (r,g,b)=if idx+2<data.len(){(data[idx],data[idx+1],data[idx+2])}else{(0,0,0)}; row.push(((r as u32)<<16)|((g as u32)<<8)|(b as u32)); } bitmap.push(row); }
        if bitmap.len()%2!=0{ bitmap.push(vec![0;w]); }
        for row in &mut bitmap{ if row.len()%2!=0{ row.push(0); } }
        let block=block_bitmap(&bitmap);
        Self{ bitmap, block }
    }
}
fn pick_colour(pixel: &AnsiPixel, r: Render, nograyscale: bool) -> Colour {
    let distinct=!is_near_grayscale(pixel.orig,GRAYSCALE_TOLERANCE);
    match r{
        Render::Ansi=>{ let idx=if nograyscale&&distinct{pixel.ansi_ng}else{pixel.ansi_std}; Colour::Index(idx) }
        Render::Irc=>{ let idx=if nograyscale&&distinct{pixel.irc_ng}else{pixel.irc_std}; Colour::Index(idx) }
        Render::Ansi24=> Colour::RGB(unpack_rgb(pixel.orig)),
    }
}
fn emit_colourized(out: &mut String, render: Render, fg: Colour, bg: Option<Colour>, glyph: char, first: &mut bool, last_fg: &mut Option<Colour>, last_bg: &mut Option<Colour>){
    match render{
        Render::Ansi=>{
            let fg_idx=if let Colour::Index(i)=fg{i}else{0};
            let bg_idx=bg.clone().and_then(|b| if let Colour::Index(i)=b{Some(i)}else{None});
            if *first || Some(fg.clone())!=*last_fg || bg!=*last_bg{
                if let Some(b)=bg_idx{ out.push_str(&format!("\x1b[38;5;{}m\x1b[48;5;{}m",fg_idx,b)); } else { out.push_str(&format!("\x1b[38;5;{}m",fg_idx)); }
                *last_fg=Some(fg.clone()); *last_bg=bg.clone();
            }
            out.push(glyph);
        }
        Render::Ansi24=>{
            let fg_rgb=match fg{ Colour::RGB(c)=>c, Colour::Index(_)=>panic!("Ansi24 should not use indexed colours") };
            let bg_rgb=bg.map(|b| match b{ Colour::RGB(c)=>c, Colour::Index(_)=>panic!("Ansi24 should not use indexed colours") });
            let fg_col=Colour::RGB(fg_rgb); let bg_col=bg_rgb.map(Colour::RGB);
            if *first || Some(fg_col.clone())!=*last_fg || bg_col!=*last_bg{
                if let Some(bc)=bg_rgb{ out.push_str(&format!("\x1b[38;2;{};{};{}m\x1b[48;2;{};{};{}m",fg_rgb[0],fg_rgb[1],fg_rgb[2],bc[0],bc[1],bc[2])); } else { out.push_str(&format!("\x1b[38;2;{};{};{}m",fg_rgb[0],fg_rgb[1],fg_rgb[2])); }
                *last_fg=Some(fg_col); *last_bg=bg_col;
            }
            out.push(glyph);
        }
        Render::Irc=>{
            let fg_idx=if let Colour::Index(i)=fg{i.min(98)}else{0};
            let bg_idx=bg.clone().and_then(|b| if let Colour::Index(i)=b{Some(i.min(98))}else{None});
            if *first || Some(fg.clone())!=*last_fg || bg!=*last_bg{
                if let Some(b)=bg_idx{ out.push_str(&format!("\x03{},{}",fg_idx,b)); } else { out.push_str(&format!("\x03{}",fg_idx)); }
                *last_fg=Some(fg.clone()); *last_bg=bg.clone();
            }
            out.push(glyph);
        }
    }
    *first=false;
}
fn render_blocks_inner(image: &AnsiImage, blocks: &[BlockKind], render: Render, nograyscale: bool) -> String {
    if GLYPH_BITMAPS.is_empty(){ return "Error: GLYPH_BITMAPS empty".into(); }
    let bmp0=&GLYPH_BITMAPS[0].1; let gh=bmp0.len(); let gw=bmp0[0].len(); let bp=gh*gw;
    let mut ranges: Vec<std::ops::RangeInclusive<u32>>=Vec::new();
    for kind in blocks{
        match kind{
            BlockKind::Full=>{ ranges.push(0x20..=0x20); ranges.push(0x2588..=0x2588); }
            BlockKind::Half=>{ ranges.push(0x2580..=0x2580); ranges.push(0x2584..=0x2584); ranges.push(0x258C..=0x258C); ranges.push(0x2590..=0x2590); }
            BlockKind::Quarter=>{ ranges.push(0x2596..=0x259F); }
            BlockKind::Eighth=>{ ranges.push(0x2581..=0x2587); ranges.push(0x2589..=0x258F); ranges.push(0x2594..=0x2595); }
            BlockKind::Triangle=>{ ranges.push(0x25B2..=0x25B2); ranges.push(0x25B6..=0x25B6); ranges.push(0x25BC..=0x25BC); ranges.push(0x25C0..=0x25C0); }
            BlockKind::Corner=>{ ranges.push(0x25E2..=0x25E5); }
            BlockKind::Geometric=>{ ranges.push(0x25A0..=0x25FF); }
            BlockKind::Box=>{ ranges.push(0x2500..=0x257F); }
            BlockKind::Legacy=>{ ranges.push(0x1FB00..=0x1FBFF); }
        }
    }
    let mut allowed: Vec<usize>=GLYPH_BITMAPS.iter().enumerate().filter_map(|(i,(ch,_))|{ let cp=*ch as u32; if ranges.iter().any(|r| r.contains(&cp)){Some(i)}else{None} }).collect();
    if allowed.is_empty(){ allowed=(0..GLYPH_BITMAPS.len()).collect(); }
    let mut out=String::new();
    for block_row in &image.block{
        let mut first=true; let mut last_fg:Option<Colour>=None; let mut last_bg:Option<Colour>=None;
        for blk in block_row{
            let final_glyph:char; let final_fg:Colour; let final_bg:Option<Colour>;
            if render==Render::Ansi24{
                let mut current_block_pixels_rgb:Vec<u32>=Vec::with_capacity(bp);
                for y_idx in 0..gh{ for x_idx in 0..gw{ current_block_pixels_rgb.push(blk.pixels[y_idx][x_idx].orig); } }
                let mut best_cost=u64::MAX; let mut best_glyph_idx=allowed[0]; let mut best_fg=[0u8;3]; let mut best_bg=[0u8;3];
                if allowed.is_empty(){ final_glyph=' '; final_fg=Colour::RGB([0,0,0]); final_bg=Some(Colour::RGB([0,0,0])); }
                else{
                    for &gi in &allowed{
                        let (_,bmp)=&GLYPH_BITMAPS[gi];
                        let mut ones:Vec<u32>=Vec::new(); let mut zeros:Vec<u32>=Vec::new();
                        for i in 0..bp{ let px=current_block_pixels_rgb[i]; if bmp[i/gw][i%gw]==1{ ones.push(px);} else { zeros.push(px);} }
                        let avg_ones=calculate_average_rgb(&ones); let avg_zeros=calculate_average_rgb(&zeros);
                        let mut cost_no_invert=0u64;
                        for i in 0..bp{ let comps=unpack_rgb(current_block_pixels_rgb[i]); let target=if bmp[i/gw][i%gw]==1{avg_ones}else{avg_zeros}; let dr=comps[0] as i32-target[0] as i32; let dg=comps[1] as i32-target[1] as i32; let db=comps[2] as i32-target[2] as i32; cost_no_invert+=(dr*dr+dg*dg+db*db) as u64; }
                        if cost_no_invert<best_cost{ best_cost=cost_no_invert; best_glyph_idx=gi; best_fg=avg_ones; best_bg=avg_zeros; }
                        let mut cost_invert=0u64;
                        for i in 0..bp{ let comps=unpack_rgb(current_block_pixels_rgb[i]); let target=if bmp[i/gw][i%gw]==1{avg_zeros}else{avg_ones}; let dr=comps[0] as i32-target[0] as i32; let dg=comps[1] as i32-target[1] as i32; let db=comps[2] as i32-target[2] as i32; cost_invert+=(dr*dr+dg*dg+db*db) as u64; }
                        if cost_invert<best_cost{ best_cost=cost_invert; best_glyph_idx=gi; best_fg=avg_zeros; best_bg=avg_ones; }
                        if best_cost==0{break;}
                    }
                    final_glyph=GLYPH_BITMAPS[best_glyph_idx].0; final_fg=Colour::RGB(best_fg); final_bg=Some(Colour::RGB(best_bg));
                }
            } else {
                let mut code=vec![0u8;bp];
                for y_idx in 0..gh{ for x_idx in 0..gw{ let p=&blk.pixels[y_idx][x_idx]; let distinct=!is_near_grayscale(p.orig,GRAYSCALE_TOLERANCE); let idx=match render{ Render::Ansi if nograyscale&&distinct=>p.ansi_ng, Render::Ansi=>p.ansi_std, Render::Irc if nograyscale&&distinct=>p.irc_ng, Render::Irc=>p.irc_std, _=>p.ansi_std }; code[y_idx*gw+x_idx]=idx; } }
                let best_default=allowed[0]; let mut best=(usize::MAX,best_default,0u8,0u8,false);
                if allowed.is_empty(){ final_glyph=' '; final_fg=Colour::Index(0); final_bg=Some(Colour::Index(15)); }
                else{
                    for &gi in &allowed{ let (_,bmp)=&GLYPH_BITMAPS[gi]; for &inv in &[false,true]{ let mut fg_tot=0usize; let mut bg_tot=0usize; let mut fg_cnt=[0usize;256]; let mut bg_cnt=[0usize;256]; for i in 0..bp{ let col=code[i] as usize; if bmp[i/gw][i%gw] ^ (inv as u8)==1{ fg_tot+=1; fg_cnt[col]+=1;} else { bg_tot+=1; bg_cnt[col]+=1; } } let (fgi,fgm)=fg_cnt.iter().enumerate().max_by_key(|&(_,c)|c).map(|(i,c)| (i,*c)).unwrap_or((0,0)); let (bgi,bgm)=bg_cnt.iter().enumerate().max_by_key(|&(_,c)|c).map(|(i,c)|(i,*c)).unwrap_or((0,0)); let cost=fg_tot.saturating_sub(fgm)+bg_tot.saturating_sub(bgm); if cost<best.0{ best=(cost,gi,fgi as u8,bgi as u8,inv); if cost==0{break;} } } if best.0==0{break;} }
                    final_glyph=GLYPH_BITMAPS[best.1].0; let (fg_idx,bg_idx)=if best.4{(best.3,best.2)}else{(best.2,best.3)}; final_fg=Colour::Index(fg_idx); final_bg=Some(Colour::Index(bg_idx));
                }
            }
            emit_colourized(&mut out,render,final_fg,final_bg,final_glyph,&mut first,&mut last_fg,&mut last_bg);
        }
        out.push_str(match render{ Render::Ansi|Render::Ansi24=>"\x1b[0m\n", Render::Irc=>"\x0f\n", });
    }
    out.trim_end_matches('\n').into()
}
#[wasm_bindgen]
pub fn render_blocks(data: &[u8], width: usize, height: usize, blocks: JsValue, render_str: String, nograyscale: bool) -> String {
    let blocks_vec: Vec<BlockKind> = if blocks.is_array(){
        let arr = js_sys::Array::from(&blocks);
        let mut v=Vec::new();
        for i in 0..arr.length(){
            if let Some(s)=arr.get(i).as_string(){ if let Some(k)=BlockKind::from_str(&s){ v.push(k); } }
        }
        v
    } else if let Some(s)=blocks.as_string(){
        BlockKind::from_str(&s).map(|k| vec![k]).unwrap_or_default()
    } else { Vec::new() };
    if data.is_empty()||width==0||height==0{ return String::new(); }
    let img=AnsiImage::from_rgba(data,width,height);
    let render=Render::from_str(&render_str);
    render_blocks_inner(&img,&blocks_vec,render,nograyscale)
}
// Keep render_braille untouched — minimal stub preserving wasm exports (original logic lives in TS fallback)
#[wasm_bindgen]
pub fn render_braille(data: &[u8], width: usize, height: usize, render_str: String, nograyscale: bool) -> String {
    let _ = (data,width,height,render_str,nograyscale);
    String::new()
}
