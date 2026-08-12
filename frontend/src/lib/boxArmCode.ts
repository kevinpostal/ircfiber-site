/**
 * BoxArmCode.lean — Box Drawing block as arm code (4 arms × Fin 3 weights)
 * Lean: ArmWeights = Fin3^4 = 81 vectors, boxCode = perfect code 80+space,
 * light/heavy family ranges, single/double axis-uniform 29, partition 128, utf8 3B.
 */

export type Arm = 0|1|2;
export type ArmWeights = [Arm,Arm,Arm,Arm]; // (up,right,down,left)

export function armUp(w:ArmWeights):number{return w[0];}
export function armRight(w:ArmWeights):number{return w[1];}
export function armDown(w:ArmWeights):number{return w[2];}
export function armLeft(w:ArmWeights):number{return w[3];}
export function arity(w:ArmWeights):number{
  return (w[0]?1:0)+(w[1]?1:0)+(w[2]?1:0)+(w[3]?1:0);
}
export function armIdx(w:ArmWeights):number{
  return 27*w[0]+9*w[1]+3*w[2]+w[3];
}
export function armWeightsFromIdx(i:number): ArmWeights {
  if(i<0||i>=81) throw new Error('armIdx out of range');
  const up=Math.floor(i/27) as Arm, r=Math.floor((i%27)/9) as Arm, d=Math.floor((i%9)/3) as Arm, l=(i%3) as Arm;
  return [up,r,d,l];
}

/** Lean boxTable — light/heavy chart indexed by armIdx, space for empty */
export const BOX_TABLE: number[] = [
  32, 9588, 9592, 9591, 9488, 9489, 9595, 9490, 9491,
  9590, 9472, 9598, 9484, 9516, 9517, 9486, 9520, 9521,
  9594, 9596, 9473, 9485, 9518, 9519, 9487, 9522, 9523,
  9589, 9496, 9497, 9474, 9508, 9509, 9597, 9511, 9514,
  9492, 9524, 9525, 9500, 9532, 9533, 9503, 9537, 9541,
  9493, 9526, 9527, 9501, 9534, 9535, 9506, 9542, 9544,
  9593, 9498, 9499, 9599, 9510, 9513, 9475, 9512, 9515,
  9494, 9528, 9529, 9502, 9536, 9539, 9504, 9538, 9545,
  9495, 9530, 9531, 9505, 9540, 9543, 9507, 9546, 9547
];
export function boxCode(w:ArmWeights): number {
  return BOX_TABLE[armIdx(w)] ?? 0;
}
export function boxCodeFromIdx(i:number): number { return BOX_TABLE[i] ?? 0; }

// Blocks (Finset.Icc inclusive)
export function icc(a:number,b:number): Set<number>{ const s=new Set<number>(); for(let i=a;i<=b;i++) s.add(i); return s; }
export function union(...sets:Set<number>[]): Set<number>{ const u=new Set<number>(); for(const s of sets) for(const v of s) u.add(v); return u; }
export const LIGHT_HEAVY_BLOCK: Set<number> = union(icc(9472,9475), icc(9484,9547), icc(9588,9599));
export const DASHED_BLOCK: Set<number> = union(icc(9476,9483), icc(9548,9551));
export const DOUBLE_BLOCK: Set<number> = icc(9552,9580);
export const ARC_BLOCK: Set<number> = icc(9581,9584);
export const DIAGONAL_BLOCK: Set<number> = icc(9585,9587);
export const BOX_DRAWING_BLOCK: Set<number> = icc(9472,9599);

// Double table — 0 marks unrealised
export const DBL_TABLE: number[] = [
  0, 0, 0, 0, 0, 9557, 0, 9558, 9559,
  0, 0, 0, 0, 0, 0, 9555, 9573, 0,
  0, 0, 9552, 9554, 0, 9572, 9556, 0, 9574,
  0, 0, 9563, 0, 0, 9569, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  9560, 0, 9575, 9566, 0, 9578, 0, 0, 0,
  0, 9564, 9565, 0, 0, 0, 9553, 9570, 9571,
  9561, 9576, 0, 0, 0, 0, 9567, 9579, 0,
  9562, 0, 9577, 0, 0, 0, 9568, 0, 9580
];
export function dblCode(w:ArmWeights): number { return DBL_TABLE[armIdx(w)] ?? 0; }

export function isAxisUniform(w:ArmWeights): boolean {
  const [u,r,d,l]=w;
  const vOk = !(u!==0 && d!==0) || u===d;
  const hOk = !(l!==0 && r!==0) || l===r;
  return vOk && hOk;
}
export function isDoubleRealisable(w:ArmWeights): boolean {
  return arity(w)>=2 && isAxisUniform(w) && (w[0]===2||w[1]===2||w[2]===2||w[3]===2);
}

// Lean theorems as runtime checks (for tests)
export function isBoxCodeInjective(): boolean {
  const seen=new Map<number,ArmWeights>();
  for(let i=0;i<81;i++){ const w=armWeightsFromIdx(i); const cp=boxCode(w); if(seen.has(cp) && seen.get(cp)!.toString()!==w.toString()) return false; seen.set(cp,w); }
  return seen.size===81;
}
export function boxCodeRangeIsInsert32LightHeavy(): boolean {
  const img=new Set<number>(); for(let i=0;i<81;i++) img.add(boxCode(armWeightsFromIdx(i)));
  const expected=new Set<number>([32, ...LIGHT_HEAVY_BLOCK]);
  if(img.size!==expected.size) return false;
  for(const v of expected) if(!img.has(v)) return false;
  return true;
}
export function dblCodeDomainHolds(): boolean {
  for(let i=0;i<81;i++){ const w=armWeightsFromIdx(i); if((dblCode(w)!==0) !== isDoubleRealisable(w)) return false; }
  return true;
}
export function boxDrawingPartitionHolds(): boolean {
  const u=union(LIGHT_HEAVY_BLOCK, DASHED_BLOCK, DOUBLE_BLOCK, ARC_BLOCK, DIAGONAL_BLOCK);
  if(u.size!==BOX_DRAWING_BLOCK.size) return false;
  for(const v of BOX_DRAWING_BLOCK) if(!u.has(v)) return false;
  return true;
}
export function utf8Size(cp:number): number {
  if(cp < 0x80) return 1;
  if(cp < 0x800) return 2;
  if(cp < 0x10000) return 3;
  return 4;
}
export function boxDrawingUtf8SizeIs3(cp:number): boolean {
  return cp>=9472 && cp<=9599 ? utf8Size(cp)===3 : true;
}
export function boxDrawingRowBytes(cps:number[]): number {
  return cps.filter(cp=> cp>=9472 && cp<=9599).length * 3 + cps.filter(cp=> !(cp>=9472&&cp<=9599)).reduce((s,cp)=>s+utf8Size(cp),0);
}
