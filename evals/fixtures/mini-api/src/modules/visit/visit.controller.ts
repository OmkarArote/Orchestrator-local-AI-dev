import { VisitService } from './visit.service';
@Controller('visits')
export class VisitController {
  constructor(private svc: VisitService) {}
  @Post('check-out')
  checkOut() {}
  @Get()
  list() {}
}
