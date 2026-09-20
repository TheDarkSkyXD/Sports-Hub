'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';

// Desktop window fullscreen lets overlays handle Escape before the room exits.
// Browsers fullscreen the document so dialog portals remain in the top layer.
export function useRoomFullscreen(room: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const desktop = window.sundayDesktop;
    if (desktop?.onFullscreenChange) return desktop.onFullscreenChange(setFullscreen);
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  useEffect(() => {
    if (!fullscreen || !room.current) return;
    const previous = document.body.style.overflow;
    const previousFocus = document.activeElement;
    const hiddenBranches = new Map<HTMLElement, boolean>();
    // Exclude the covered page from keyboard navigation. Stop at the body so
    // portaled dialogs and audio menus remain interactive above the room.
    let branch: HTMLElement = room.current;
    while (branch.parentElement && branch.parentElement !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          hiddenBranches.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    document.body.style.overflow = 'hidden';
    const focusWasOutside = !room.current.contains(previousFocus);
    if (focusWasOutside) room.current.querySelector<HTMLButtonElement>('button[aria-label="Exit fullscreen"]')?.focus();
    return () => {
      document.body.style.overflow = previous;
      for (const [element, inert] of hiddenBranches) element.inert = inert;
      if (focusWasOutside && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [fullscreen, room]);
  const exit = useCallback(async () => {
    if (window.sundayDesktop?.setFullscreen) {
      // A failed desktop bridge must not trap the viewport-only fallback.
      try { await window.sundayDesktop.setFullscreen(false); } catch {}
      setFullscreen(false);
      return;
    }
    if (document.fullscreenElement) await document.exitFullscreen();
    setFullscreen(false);
  }, []);
  const toggle = useCallback(async () => {
    if (fullscreen) return exit();
    try {
      if (window.sundayDesktop?.setFullscreen) {
        setFullscreen(await window.sundayDesktop.setFullscreen(true));
        return;
      }
      if (!document.documentElement.requestFullscreen) throw new Error('Unavailable');
      await document.documentElement.requestFullscreen();
      setFullscreen(true);
    } catch {
      setFullscreen(true);
    }
  }, [fullscreen, exit]);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"],[role="listbox"]')) void exit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullscreen, exit]);
  return { fullscreen, toggle, exit };
}
