import { helper } from './util';

class Animal {
  speak() {
    return 'hi';
  }
}

class Dog extends Animal {
  constructor(name) {
    super();
    this.name = name;
  }
  fetch() {
    helper(this.name);
  }
}

function main() {
  const d = new Dog('Rex');
  d.fetch();
  helper();
}

const add = (a, b) => a + b;
