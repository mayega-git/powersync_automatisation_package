package io.taskly.api.web;

public class ConflictException extends RuntimeException {
    public ConflictException(String message) {
        super(message);
    }
}
