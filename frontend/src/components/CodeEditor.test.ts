import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import CodeEditor from './CodeEditor.svelte';

describe('CodeEditor', () => {
  it('renders with initial value and highlights', async () => {
    const { container } = render(CodeEditor, { props: { value: 'def hello():\n  pass', language: 'python' } });
    expect(container.querySelector('textarea')?.value).toContain('def hello');
    expect(container.querySelector('.hlLayer')?.textContent).toContain('def');
  });
});
