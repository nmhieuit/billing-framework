export function countWords(text) {
  let count = 0;
  for (const part of text.split(' ')) {
    if (part !== '') {
      count = count + 1;
    }
  }
  return count;
}
