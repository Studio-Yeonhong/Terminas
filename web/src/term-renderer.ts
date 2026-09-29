// 터미널 그리기: 그래픽 카드(WebGL)가 있으면 WebGL 로 그린다 — 기본(DOM)보다 글자를 치고 지울 때 훨씬 부드럽다.
// GPU 없이 소프트웨어로만 도는 WebGL(원격 데스크톱·GPU 없는 VM 의 "Basic Render Driver"·SwiftShader 등)에서는
// 오히려 느릴 수 있어 기본(DOM)으로 둔다. WebGL 이 도중에 끊기면(그래픽 드라이버 재시작 등) DOM 으로 돌아간다.
import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export type RendererMode = 'auto' | 'on' | 'off';

let hardware: boolean | null = null;
export function hardwareWebgl() {
  if (hardware !== null) return hardware;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return (hardware = false);
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    hardware = !/SwiftShader|Basic Render|llvmpipe|softpipe|software/i.test(renderer);
  } catch {
    hardware = false;
  }
  return hardware;
}

// term.open() 뒤에 부른다. 실제로 쓰게 된 방식을 돌려준다
export function applyRenderer(term: Terminal, mode: RendererMode): 'webgl' | 'dom' {
  if (mode === 'off' || (mode === 'auto' && !hardwareWebgl())) return 'dom';
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    term.loadAddon(addon);
    return 'webgl';
  } catch {
    return 'dom';
  }
}
