use std::fmt;
use crate::utils::helper;

mod utils;

trait Animal {
    fn speak(&self) -> String;
}

struct Dog {
    name: String,
}

impl Dog {
    fn new(name: String) -> Dog {
        Dog { name }
    }
    fn speak(&self) -> String {
        self.name.clone()
    }
}

impl Animal for Dog {
    fn speak(&self) -> String {
        self.name.clone()
    }
}

enum Color {
    Red,
    Green,
}

fn main() {
    let d = Dog::new("Rex".to_string());
    println!("{}", d.speak());
    let x = helper();
    x();
}

fn helper() -> u32 {
    42
}
