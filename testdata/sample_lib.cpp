#include <iostream>
#include "myheader.h"

class Animal {
public:
    Animal(string n) : name(n) {}
    string speak() { return makeSound(); }
private:
    string makeSound() { return "noise"; }
    string name;
};

class Dog : public Animal {
public:
    string speak() { return bark(); }
};

struct Serializable {};

enum Color { RED, GREEN, BLUE };

void helper(Dog d) {
    d.speak();
}

int main() {
    Dog d("Rex");
    d.speak();
    helper(d);
    return 0;
}
