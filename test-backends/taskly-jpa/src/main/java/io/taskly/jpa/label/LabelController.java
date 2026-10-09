package io.taskly.jpa.label;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/labels")
public class LabelController {

    private final LabelRepository labels;

    public LabelController(LabelRepository labels) {
        this.labels = labels;
    }

    @GetMapping
    public List<Label> all() {
        return labels.findAllByOrderByRankAsc();
    }
}
