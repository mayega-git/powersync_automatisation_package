package io.taskly.jpa.label;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

/** Shared vocabulary, identical for every workspace. */
@Entity
@Table(name = "label")
public class Label {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String code;

    @Column(nullable = false)
    private String title;

    @Column(name = "rank", nullable = false)
    private int rank;

    protected Label() {
    }

    public UUID getId() {
        return id;
    }

    public String getCode() {
        return code;
    }

    public String getTitle() {
        return title;
    }

    public int getRank() {
        return rank;
    }
}
