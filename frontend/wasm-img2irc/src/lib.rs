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
pub fn has_simd() -> bool { true }

#[wasm_bindgen]
pub fn alpha_blend(f_r: u8, f_g: u8, f_b: u8, b_r: u8, b_g: u8, b_b: u8, t: f32) -> Vec<u8> {
    oklab_blend(f_r, f_g, f_b, b_r, b_g, b_b, t)
}
