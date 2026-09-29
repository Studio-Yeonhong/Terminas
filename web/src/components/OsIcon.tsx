// 호스트 아이콘 속 그림: OS 를 알면 그 로고(흰색), 모르면 서버 모양.
// 로고 모양은 Simple Icons(CC0) — 각 로고는 해당 회사·프로젝트의 상표이며 OS 를 알려 주는 용도로만 쓴다.
import { Server } from 'lucide-react';
import {
  siAlmalinux, siAlpinelinux, siArchlinux, siCentos, siDebian, siElementary, siEndeavouros, siFedora, siFreebsd, siGentoo,
  siKalilinux, siLinux, siLinuxmint, siMacos, siManjaro, siNixos, siOpenbsd, siOpensuse, siOpenwrt, siPopos,
  siRaspberrypi, siRedhat, siRockylinux, siSuse, siUbuntu, siVoidlinux, siZorin,
} from 'simple-icons';
import type { OsId } from '../os-detect';

// 윈도우 로고는 Simple Icons 에 없다 → 네 칸 창 모양
const windows = { title: 'Windows', path: 'M0 0h11.2v11.2H0zM12.8 0H24v11.2H12.8zM0 12.8h11.2V24H0zM12.8 12.8H24V24H12.8z' };

const ICONS: Record<OsId, { title: string; path: string }> = {
  ubuntu: siUbuntu, debian: siDebian, raspberrypi: siRaspberrypi, linuxmint: siLinuxmint, popos: siPopos, elementary: siElementary, zorin: siZorin, kali: siKalilinux,
  centos: siCentos, redhat: siRedhat, fedora: siFedora, rocky: siRockylinux, almalinux: siAlmalinux, arch: siArchlinux, manjaro: siManjaro, endeavouros: siEndeavouros,
  alpine: siAlpinelinux, opensuse: siOpensuse, suse: siSuse, gentoo: siGentoo, nixos: siNixos, void: siVoidlinux, openwrt: siOpenwrt,
  freebsd: siFreebsd, openbsd: siOpenbsd, macos: siMacos, windows, linux: siLinux,
};

export const osTitle = (os: OsId | '') => (os ? ICONS[os].title : '');

export function HostGlyph({ os, size }: { os: OsId | ''; size: number }) {
  if (!os) return <Server size={size} />;
  const icon = ICONS[os];
  // 로고는 서버 모양보다 조금 작게 보여서 살짝 키운다
  const s = Math.round(size * 1.05);
  return (
    <svg role="img" aria-label={icon.title} width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
      <title>{icon.title}</title>
      <path d={icon.path} />
    </svg>
  );
}
