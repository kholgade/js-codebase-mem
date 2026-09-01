import os
from flask import Flask, request

app = Flask(__name__)

class Base:
    def greet(self):
        return "hi"

class Service(Base):
    """A service."""

    def __init__(self):
        self.value = 42

    def compute(self, x):
        y = self.helper(x)
        return y * 2

    def helper(self, x):
        return x + self.value


@app.route("/health", methods=["GET"])
def health():
    return "ok", 200


def top_level(n):
    s = Service()
    return s.compute(n)
