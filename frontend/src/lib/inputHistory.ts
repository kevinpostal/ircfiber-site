/**
 * Input history manager. Stores sent messages per-buffer for Up/Down navigation.
 */
export class InputHistory {
  private history: string[] = [];
  private index = 0;
  private currentValue = '';
  private maxSize = 100;

  /** Add a sent message to history */
  push(text: string): void {
    if (this.history.length > 0 && this.history[this.history.length - 1] === text) return;
    this.history.push(text);
    if (this.history.length > this.maxSize) {
      this.history.shift();
    }
    this.resetIndex();
  }

  /**
   * Navigate to earlier entry (Up arrow).
   */
  getEarlier(currentInput: string): string | undefined {
    if (this.history.length === 0) return undefined;

    if (this.index === 0) {
      this.currentValue = currentInput;
    }

    const newIndex = this.index - 1;
    const entry = this.getFromEnd(newIndex);
    if (entry !== undefined) {
      this.index = newIndex;
      return entry;
    }
    return undefined;
  }

  /**
   * Navigate to later entry (Down arrow).
   */
  getLater(): string | undefined {
    if (this.index === 0) return undefined;

    const newIndex = this.index + 1;
    if (newIndex === 0) {
      this.index = 0;
      return this.currentValue;
    }

    const entry = this.getFromEnd(newIndex);
    if (entry !== undefined) {
      this.index = newIndex;
      return entry;
    }

    this.resetIndex();
    return this.currentValue;
  }

  private getFromEnd(offset: number): string | undefined {
    const idx = this.history.length + offset;
    if (idx >= 0 && idx < this.history.length) return this.history[idx];
    return undefined;
  }

  /** Reset navigation index (on any non-arrow keypress) */
  resetIndex(): void {
    this.index = 0;
    this.currentValue = '';
  }

  /** Check if input is multi-line (should skip history navigation) */
  static isMultiline(text: string): boolean {
    return text.includes('\n');
  }
}
