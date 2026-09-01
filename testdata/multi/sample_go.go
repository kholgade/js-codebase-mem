package main

import (
	"fmt"
	"strings"
)

type Animal interface {
	Speak() string
}

type Dog struct {
	name string
}

func (d Dog) Speak() string {
	return d.name
}

func (d *Dog) Rename(name string) {
	d.name = name
}

func NewDog(name string) Dog {
	return Dog{name: name}
}

func main() {
	d := NewDog("Rex")
	fmt.Println(d.Speak())
	strings.ToUpper(d.name)
	greet := doGreet
	greet()
}

func doGreet() {
	fmt.Println("hi")
}
