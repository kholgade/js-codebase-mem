using System;
using System.Collections.Generic;
using MyCorp.Lib.Service;

namespace MyApp {
    public class Animal : ISpeakable {
        private string name;
        public Animal(string name) { this.name = name; }
        public string Speak() { return MakeSound(); }
        private string MakeSound() { return "noise"; }
    }

    class Dog : Animal {
        public string Speak() { return Bark(); }
    }

    public interface ISpeakable {
        void Speak();
    }

    enum Color { RED, GREEN, BLUE }

    static class Program {
        static void Main() {
            Dog d = new Dog("Rex");
            d.Speak();
            Helper(d);
        }
    }
}

public static void Helper(Dog d) {
    d.Speak();
}
