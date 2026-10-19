'use client';

type Subscription = { element: HTMLElement; onLayout: (overlay: boolean) => void };
const subscriptions = new Set<Subscription>();
const events = ['scroll', 'resize', 'fullscreenchange', 'visibilitychange', 'focusin', 'focusout', 'pointerdown', 'pointerup', 'change', 'keyup'];
let monitoring: ReturnType<typeof startMonitoring> | null = null;
let scheduled = 0;

function sync() {
  scheduled = 0;
  const overlay = document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]') !== null;
  for (const subscription of subscriptions) subscription.onLayout(overlay);
}

function schedule() {
  if (!scheduled) scheduled = requestAnimationFrame(sync);
}

function startMonitoring() {
  const resize = new ResizeObserver(schedule);
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style', 'open', 'data-state', 'aria-hidden'] });
  for (const event of events) window.addEventListener(event, schedule, true);
  const interval = setInterval(schedule, 500);
  return {
    resize,
    dispose() {
      clearInterval(interval);
      cancelAnimationFrame(scheduled);
      scheduled = 0;
      resize.disconnect();
      mutations.disconnect();
      for (const event of events) window.removeEventListener(event, schedule, true);
    },
  };
}

export function monitorPlayerLayout(element: HTMLElement, onLayout: Subscription['onLayout']) {
  const subscription = { element, onLayout };
  subscriptions.add(subscription);
  monitoring ??= startMonitoring();
  monitoring.resize.observe(element);
  schedule();
  return {
    schedule,
    dispose() {
      if (!subscriptions.delete(subscription)) return;
      if (![...subscriptions].some(current => current.element === element)) monitoring?.resize.unobserve(element);
      if (subscriptions.size === 0) {
        monitoring?.dispose();
        monitoring = null;
      }
    },
  };
}
