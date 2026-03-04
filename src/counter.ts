/**
 * Copyright (c) 2026 Sajid Ahmed
 */
/**
 * Initialises and manages a simple counter within a given HTML element.
 * @param element - The HTML button element to attach the counter to.
 */
export function setupCounter(element: HTMLButtonElement) {
  let counter = 0
  const setCounter = (count: number) => {
    counter = count
    element.innerHTML = `count is ${counter}`
  }
  element.addEventListener('click', () => setCounter(counter + 1))
  setCounter(0)
}
