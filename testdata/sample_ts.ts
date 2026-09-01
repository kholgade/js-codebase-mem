import { helper } from './util';
import express from 'express';

interface Animal {
  name: string;
  speak(): string;
}

class Dog extends Animal implements Speakable {
  private sound = 'woof';
  constructor(private name: string) {}
  speak(): string {
    return this.sound;
  }
  fetch(): void {
    helper(this.name);
  }
}

export function main(): void {
  const d = new Dog('Rex');
  d.fetch();
}

export const add = (a: number, b: number): number => a + b;

const app = express();
app.get('/ping', (req, res) => res.send('pong'));
