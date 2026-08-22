export type OcrItem = { text:string; poly:number[]; confidence:number };
export class OcrService {
  async detect(_blob: Blob, _opts?: any): Promise<OcrItem[]> {
    // Stub: OCR disabled — vendor not shipped. Return empty without error.
    return [];
  }
  itemsToOverlays(items: OcrItem[], _cols:number, _rows:number, _opts?:any): any[] { return items.map((it,i)=>({ id:`ocr-${i}`, text: it.text, x:0,y:0,width:4,height:1, wrap:true, autoGrow:true, figlet:false, bold:false, italic:false, underline:false })); }
}
