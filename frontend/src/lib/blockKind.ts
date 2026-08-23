export type BlockKind = 'full'|'half'|'quarter'|'eighth'|'triangle'|'corner'|'geometric'|'box'|'legacy';

export function blockKindRanges(k: BlockKind): [number,number][] {
  switch(k){
    case 'full': return [[0x20,0x20],[0x2588,0x2588]];
    case 'half': return [[0x2580,0x2580],[0x2584,0x2584],[0x258C,0x258C],[0x2590,0x2590]];
    case 'quarter': return [[0x2596,0x259F]];
    case 'eighth': return [[0x2581,0x2587],[0x2589,0x258F],[0x2594,0x2595]];
    case 'triangle': return [[0x25B2,0x25B2],[0x25B6,0x25B6],[0x25BC,0x25BC],[0x25C0,0x25C0]];
    case 'corner': return [[0x25E2,0x25E5]];
    case 'geometric': return [[0x25A0,0x25FF]];
    case 'box': return [[0x2500,0x257F]];
    case 'legacy': return [[0x1FB00,0x1FBFF]];
  }
}
