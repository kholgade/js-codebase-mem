import java.util.List;
import com.example.Service;

public class Animal implements Serializable {
    private String name;

    public Animal(String name) {
        this.name = name;
    }

    public String speak() {
        return makeSound();
    }

    private String makeSound() {
        return "noise";
    }
}

class Dog extends Animal {
    public String speak() {
        return bark();
    }
}

interface Speakable {
    void speak();
}

enum Color { RED, GREEN, BLUE }

public static void main(String[] args) {
    Dog d = new Dog("Rex");
    d.speak();
    helper(d);
}
