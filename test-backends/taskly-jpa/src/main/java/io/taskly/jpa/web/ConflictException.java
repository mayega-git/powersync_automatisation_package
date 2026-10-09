package io.taskly.jpa.web;

public class ConflictException extends RuntimeException {
    public ConflictException(String message) {
        super(message);
    }
}
